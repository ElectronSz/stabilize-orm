import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  activeKeyId,
  decrypt,
  encrypt,
  resetEncryptionKeyCache,
} from "../utils/encryption";
import { Stabilize } from "../index";
import { defineModel } from "../model";
import { DataTypes, DBType, StabilizeError } from "../types";

/**
 * Column encryption.
 *
 * Three things are under test here, and they are one story: the ciphertext now
 * names the key that wrote it, the key comes from a chain that can generate one
 * rather than only read one, and a renamed encrypted column decrypts.
 *
 * Earlier versions encrypted with a constant published in this package, so
 * every deployment that never set the variable protected nothing; the
 * ciphertext was also unauthenticated CBC, so a tampered value decrypted to
 * garbage instead of failing. Both are covered below, because both have to keep
 * reading.
 */

const KEY_A = "key-a-32-bytes-long-padding-!!!!";
const KEY_B = "key-b-32-bytes-long-padding-!!!!";
/** The constant versions before this one encrypted with. */
const LEGACY_KEY = "f71a3c8e9b12d5a49c0a3f98b1f2e46d";

/** AES-256-GCM with no key id — the `v2:` format nothing writes any more. */
function encryptV2(plaintext: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "utf8"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/** Unauthenticated `iv:ciphertext` — the format before that. */
function encryptLegacyCbc(plaintext: string, key: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(key, "utf8"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64")}:${encrypted.toString("base64")}`;
}

describe("column encryption", () => {
  const originalKey = process.env.ORM_ENCRYPTION_KEY;
  const originalFile = process.env.ORM_ENCRYPTION_KEY_FILE;
  const originalRetired = process.env.ORM_ENCRYPTION_KEYS_OLD;

  let dir: string;
  let file: string;

  beforeEach(() => {
    // Every test gets its own empty directory, pointed at explicitly. Without
    // that, a test with no env var would generate a key at the default path —
    // inside the repository.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stabilize-enc-"));
    file = path.join(dir, "encryption.key");
    process.env.ORM_ENCRYPTION_KEY_FILE = file;
    process.env.ORM_ENCRYPTION_KEY = KEY_A;
    delete process.env.ORM_ENCRYPTION_KEYS_OLD;
    resetEncryptionKeyCache();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ORM_ENCRYPTION_KEY;
    else process.env.ORM_ENCRYPTION_KEY = originalKey;
    if (originalFile === undefined) delete process.env.ORM_ENCRYPTION_KEY_FILE;
    else process.env.ORM_ENCRYPTION_KEY_FILE = originalFile;
    if (originalRetired === undefined) delete process.env.ORM_ENCRYPTION_KEYS_OLD;
    else process.env.ORM_ENCRYPTION_KEYS_OLD = originalRetired;
    resetEncryptionKeyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a value", () => {
    const encrypted = encrypt("111-11-1111");
    expect(encrypted).not.toBe("111-11-1111");
    expect(decrypt(encrypted)).toBe("111-11-1111");
  });

  it("produces a different ciphertext each time", () => {
    // A fixed IV would leak that two rows hold the same value.
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("writes the authenticated format, naming the key that wrote it", () => {
    const parts = encrypt("value").split(":");

    expect(parts[0]).toBe("v3");
    // Without the id, rotating means re-encrypting every row at once.
    expect(parts[1]).toBe(activeKeyId());
    expect(parts).toHaveLength(5);
  });

  it("names the same key for the same bytes from either source", () => {
    // The id is derived from the key, not assigned, so a key moved from the
    // environment into the file does not orphan the rows it wrote.
    const fromEnv = activeKeyId();
    const encrypted = encrypt("value");

    delete process.env.ORM_ENCRYPTION_KEY;
    fs.writeFileSync(file, JSON.stringify({ active: KEY_A, retired: [] }));
    resetEncryptionKeyCache();

    expect(activeKeyId()).toBe(fromEnv);
    expect(decrypt(encrypted)).toBe("value");
  });

  it("rejects a tampered ciphertext", () => {
    const parts = encrypt("111-11-1111").split(":");
    const data = Buffer.from(parts[4]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[4] = data.toString("base64");

    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("names the missing key id when it cannot decrypt", () => {
    const encrypted = encrypt("secret");
    const id = encrypted.split(":")[1]!;

    process.env.ORM_ENCRYPTION_KEY = KEY_B;
    resetEncryptionKeyCache();

    expect(() => decrypt(encrypted)).toThrow(new RegExp(id));
    expect(() => decrypt(encrypted)).toThrow(/retired/);
  });

  it("still reads the v2 format, which names no key", () => {
    const legacy = encryptV2("111-11-1111", KEY_A);
    expect(decrypt(legacy)).toBe("111-11-1111");
  });

  it("still reads the legacy unauthenticated format", () => {
    const legacy = encryptLegacyCbc("111-11-1111", LEGACY_KEY);
    process.env.ORM_ENCRYPTION_KEY = LEGACY_KEY;
    resetEncryptionKeyCache();

    // Existing rows must stay readable after the format change.
    expect(decrypt(legacy)).toBe("111-11-1111");
  });

  it("rejects malformed input", () => {
    expect(() => decrypt("not-encrypted-at-all")).toThrow(/format/i);
  });

  it("rejects a key of the wrong length", () => {
    process.env.ORM_ENCRYPTION_KEY = "too-short";
    resetEncryptionKeyCache();
    expect(() => encrypt("value")).toThrow(/32 bytes/);
  });

  it("accepts a 64-character hex key", () => {
    process.env.ORM_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    resetEncryptionKeyCache();
    expect(decrypt(encrypt("value"))).toBe("value");
  });

  describe("the key file", () => {
    it("generates one when nothing is configured, and reuses it", () => {
      delete process.env.ORM_ENCRYPTION_KEY;

      const encrypted = encrypt("value");

      expect(fs.existsSync(file)).toBe(true);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(written.active).toMatch(/^[0-9a-f]{64}$/);
      expect(written.retired).toEqual([]);

      // Re-read from disk rather than from the cache: a key that only lives in
      // memory would make this value unreadable at the next restart.
      resetEncryptionKeyCache();
      expect(decrypt(encrypted)).toBe("value");
    });

    it("keeps the generated file to the owner", () => {
      delete process.env.ORM_ENCRYPTION_KEY;
      encrypt("value");

      // POSIX only — Windows has no mode bits to assert on.
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it("creates the directory it needs", () => {
      delete process.env.ORM_ENCRYPTION_KEY;
      const nested = path.join(dir, "deep", "nested", "encryption.key");
      process.env.ORM_ENCRYPTION_KEY_FILE = nested;

      const encrypted = encrypt("value");

      expect(fs.existsSync(nested)).toBe(true);
      expect(decrypt(encrypted)).toBe("value");
    });

    it("refuses to invent a key it cannot store", () => {
      delete process.env.ORM_ENCRYPTION_KEY;
      // A path whose parent is a *file*: the directory cannot be created, so
      // there is nowhere for a generated key to go.
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "not a directory");
      process.env.ORM_ENCRYPTION_KEY_FILE = path.join(blocker, "encryption.key");

      // Silently using an unstored key would lose every value written under it.
      expect(() => encrypt("value")).toThrow(/Cannot create the directory/);
    });

    it("reads a file holding nothing but the key", () => {
      delete process.env.ORM_ENCRYPTION_KEY;
      fs.writeFileSync(file, KEY_A + "\n");
      resetEncryptionKeyCache();

      expect(decrypt(encrypt("value"))).toBe("value");
    });

    it("rejects a file that is not a key", () => {
      delete process.env.ORM_ENCRYPTION_KEY;
      fs.writeFileSync(file, "{ not json");
      resetEncryptionKeyCache();

      expect(() => encrypt("value")).toThrow(/not valid JSON/);
    });
  });

  describe("rotation", () => {
    /** Encrypts under `KEY_A`, then makes `KEY_B` active and `KEY_A` retired. */
    function rotate(): string {
      const encrypted = encrypt("written under A");
      delete process.env.ORM_ENCRYPTION_KEY;
      fs.writeFileSync(
        file,
        JSON.stringify({ active: KEY_B, retired: [KEY_A] }),
      );
      resetEncryptionKeyCache();
      return encrypted;
    }

    it("reads values written under a retired key", () => {
      expect(decrypt(rotate())).toBe("written under A");
    });

    it("encrypts new values under the new key", () => {
      const before = activeKeyId();
      rotate();

      expect(activeKeyId()).not.toBe(before);
      expect(encrypt("value").split(":")[1]).toBe(activeKeyId());
    });

    it("reads the old formats against a retired key too", () => {
      const v2 = encryptV2("from v2", KEY_A);
      const cbc = encryptLegacyCbc("from cbc", KEY_A);

      rotate();

      // Neither format names a key, so the ring is walked — the active key
      // fails authentication and the retired one succeeds.
      expect(decrypt(v2)).toBe("from v2");
      expect(decrypt(cbc)).toBe("from cbc");
    });

    it("takes retired keys from the environment when there is no file", () => {
      const encrypted = encrypt("value");

      process.env.ORM_ENCRYPTION_KEY = KEY_B;
      process.env.ORM_ENCRYPTION_KEYS_OLD = `${KEY_A}, ${LEGACY_KEY}`;
      resetEncryptionKeyCache();

      expect(decrypt(encrypted)).toBe("value");
    });

    it("stops reading a key that is no longer configured", () => {
      const encrypted = rotate();

      process.env.ORM_ENCRYPTION_KEY = KEY_B;
      process.env.ORM_ENCRYPTION_KEY_FILE = path.join(dir, "absent.key");
      resetEncryptionKeyCache();

      expect(() => decrypt(encrypted)).toThrow(/not configured/);
    });
  });
});

describe("encrypted columns through the repository", () => {
  const originalKey = process.env.ORM_ENCRYPTION_KEY;
  const originalFile = process.env.ORM_ENCRYPTION_KEY_FILE;
  let dir: string;

  /** A renamed encrypted column, and one that is not renamed. */
  const Patient = defineModel({
    tableName: "encrypted_patients",
    columns: {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      fullName: { type: DataTypes.STRING, name: "full_name" },
      ssn: { type: DataTypes.STRING, encrypted: true },
      diagnosis: {
        type: DataTypes.STRING,
        name: "diagnosis_code",
        encrypted: true,
      },
    },
  });

  let db: Stabilize;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stabilize-enc-repo-"));
    process.env.ORM_ENCRYPTION_KEY = KEY_A;
    process.env.ORM_ENCRYPTION_KEY_FILE = path.join(dir, "encryption.key");
    resetEncryptionKeyCache();

    db = new Stabilize({ type: DBType.SQLite, connectionString: ":memory:" });
    await db.autoMigrate([Patient]);
  });

  afterEach(async () => {
    await db.close();
    if (originalKey === undefined) delete process.env.ORM_ENCRYPTION_KEY;
    else process.env.ORM_ENCRYPTION_KEY = originalKey;
    if (originalFile === undefined) delete process.env.ORM_ENCRYPTION_KEY_FILE;
    else process.env.ORM_ENCRYPTION_KEY_FILE = originalFile;
    resetEncryptionKeyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores ciphertext and returns plaintext", async () => {
    const repo = db.getRepository(Patient);
    const created = await repo.create({ fullName: "Ada", ssn: "111-11-1111" } as any);

    const raw = await db.client.query<any>(
      "SELECT ssn FROM encrypted_patients",
    );
    expect(raw[0]!.ssn).not.toBe("111-11-1111");
    expect(raw[0]!.ssn.startsWith("v3:")).toBe(true);

    const found = await repo.findOne((created as any).id);
    expect((found as any).ssn).toBe("111-11-1111");
  });

  it("decrypts an encrypted column that is also renamed", async () => {
    // `this.columns` is keyed by property name and rows arrive keyed by column
    // name, so this read looked for `diagnosis` in a row holding
    // `diagnosis_code` and handed the ciphertext straight back.
    const repo = db.getRepository(Patient);
    const created = await repo.create({
      fullName: "Ada",
      diagnosis: "E11.9",
    } as any);

    const found = await repo.findOne((created as any).id);

    expect((found as any).diagnosis_code).toBe("E11.9");
    expect((found as any).diagnosis_code.startsWith("v3:")).toBe(false);
  });

  it("reports an undecryptable value rather than returning it as empty", async () => {
    const repo = db.getRepository(Patient);
    const created = await repo.create({
      fullName: "Ada",
      ssn: "111-11-1111",
    } as any);

    // The key is gone, so the ciphertext that is still in the row cannot be
    // read. Returning `null` made that look like an empty field.
    process.env.ORM_ENCRYPTION_KEY = KEY_B;
    resetEncryptionKeyCache();

    // Caught rather than asserted with `rejects`: a rejected promise from
    // inside the driver hangs Bun's test runner. @see tests/events.test.ts
    let thrown: unknown = null;
    try {
      await repo.findOne((created as any).id);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StabilizeError);
    expect((thrown as Error).message).toMatch(/Failed to decrypt/);
  });
});
