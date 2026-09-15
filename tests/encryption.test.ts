import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { encrypt, decrypt } from "../utils/encryption";

/**
 * Coverage for the column encryption helpers.
 *
 * Two defects lived here: the key fell back to a constant published in the
 * source, and the cipher was unauthenticated CBC, so a tampered value decrypted
 * to garbage rather than failing.
 */

const KEY = "test-key-32-bytes-long-padding!!";
/** The constant earlier versions used when no key was configured. */
const LEGACY_KEY = "f71a3c8e9b12d5a49c0a3f98b1f2e46d";

/** Produces the unauthenticated `iv:ciphertext` format older versions wrote. */
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
  const original = process.env.ORM_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ORM_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ORM_ENCRYPTION_KEY;
    else process.env.ORM_ENCRYPTION_KEY = original;
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

  it("writes the authenticated format", () => {
    expect(encrypt("value").startsWith("v2:")).toBe(true);
  });

  it("rejects a tampered ciphertext", () => {
    const encrypted = encrypt("111-11-1111");
    const parts = encrypted.split(":");
    const data = Buffer.from(parts[3]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64");

    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("rejects a value encrypted under a different key", () => {
    const encrypted = encrypt("secret");
    process.env.ORM_ENCRYPTION_KEY = "another-key-32-bytes-long-pad!!!";
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("still reads the legacy unauthenticated format", () => {
    const legacy = encryptLegacyCbc("111-11-1111", LEGACY_KEY);
    process.env.ORM_ENCRYPTION_KEY = LEGACY_KEY;

    // Existing rows must stay readable after the format change.
    expect(decrypt(legacy)).toBe("111-11-1111");
  });

  it("rejects malformed input", () => {
    expect(() => decrypt("not-encrypted-at-all")).toThrow(/format/i);
  });

  it("refuses to operate without a configured key", () => {
    delete process.env.ORM_ENCRYPTION_KEY;

    // Previously this silently used a key published in the package.
    expect(() => encrypt("value")).toThrow(/ORM_ENCRYPTION_KEY/);
    expect(() => decrypt(encryptLegacyCbc("value", LEGACY_KEY))).toThrow(
      /ORM_ENCRYPTION_KEY/,
    );
  });

  it("rejects a key of the wrong length", () => {
    process.env.ORM_ENCRYPTION_KEY = "too-short";
    expect(() => encrypt("value")).toThrow(/32 bytes/);
  });

  it("accepts a 64-character hex key", () => {
    process.env.ORM_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    expect(decrypt(encrypt("value"))).toBe("value");
  });
});
