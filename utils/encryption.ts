/**
 * @file utils/encryption.ts
 * @description Column encryption: AES-256-GCM over a key ring that can be
 *   rotated one key at a time.
 * @author ElectronSz
 *
 * ## Where the key comes from
 *
 * A key is looked for in this order, and the first source that yields an
 * *active* key wins:
 *
 * 1. `ORM_ENCRYPTION_KEY` — 32 bytes, as 64 hex characters or as raw UTF-8.
 * 2. `ORM_ENCRYPTION_KEY_FILE` — a path, or `.stabilize/encryption.key` when
 *    the variable is unset. If the file is missing it is generated.
 *
 * Retired keys are read from the file's `retired` list and from
 * `ORM_ENCRYPTION_KEYS_OLD` (comma-separated). They never encrypt anything;
 * they exist so ciphertext written under an old key stays readable.
 *
 * ## Why the key is never built in
 *
 * `LEGACY_KEY` below is the constant this module used to encrypt with. A key
 * compiled into a published package is readable by anyone who runs `npm pack`,
 * so every deployment that never set the variable encrypted its columns with a
 * value its attackers already had — data that looked confidential and offered
 * none of the protection. It is kept only so those rows can still be read.
 *
 * ## Why generation is safe here and would not be on its own
 *
 * A key generated in memory and never written down orphans every encrypted
 * value the moment the process restarts: the ciphertext is still in the
 * database, and nothing can ever decrypt it again. So a generated key is
 * written to the key file before it is used, and if that file cannot be
 * created — a read-only filesystem, a directory the process cannot write — this
 * module throws rather than inventing a key it cannot keep.
 *
 * That still leaves a deployment question the library cannot answer: whether
 * the key file's path survives a redeploy. On a host with an ephemeral
 * filesystem it does not, and the first redeploy is the one that loses the
 * data. Set `ORM_ENCRYPTION_KEY` where that is true.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** The environment variable holding the active encryption key. */
const KEY_ENV_VAR = "ORM_ENCRYPTION_KEY";

/** An optional comma-separated list of retired keys, still readable. */
const RETIRED_KEYS_ENV_VAR = "ORM_ENCRYPTION_KEYS_OLD";

/** An optional path to the key file. */
const KEY_FILE_ENV_VAR = "ORM_ENCRYPTION_KEY_FILE";

/** Where the key is generated when nothing else says otherwise. */
const DEFAULT_KEY_FILE = ".stabilize/encryption.key";

/** The key previously hard-coded here, kept only to explain the migration. */
const LEGACY_KEY = "f71a3c8e9b12d5a49c0a3f98b1f2e46d";

/** IV length for AES-GCM, which is what `encrypt` writes today. */
const GCM_IV_LENGTH = 12;
/** AES block size — the IV length of the legacy CBC format. */
const CBC_IV_LENGTH = 16;
/** Prefix identifying the current format, which names its key. */
const GCM_ID_PREFIX = "v3";
/** Prefix identifying the format this module wrote before key ids existed. */
const GCM_PREFIX = "v2";
/** AES-256. */
const KEY_BYTES = 32;
/** Characters of the key digest used to name a key. */
const KEY_ID_LENGTH = 8;

/** The contents of a key file: one active key, and any it replaced. */
interface KeyFileData {
  active: string;
  retired: string[];
}

/** A key and the id its ciphertext refers to it by. */
interface RingKey {
  id: string;
  key: Buffer;
}

/** The keys available right now, and which one new values use. */
interface Keyring {
  active: RingKey;
  byId: Map<string, Buffer>;
  /** Every key, active first — the order legacy formats are tried in. */
  ordered: Buffer[];
}

/**
 * Parses a key from its configured form.
 *
 * 64 hex characters are read as hex; anything else is read as UTF-8. Both have
 * to come to exactly 32 bytes, because a short key is a mistake the caller
 * would otherwise only discover as unreadable data.
 */
function parseKey(configured: string, source: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "utf8");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `The encryption key from ${source} must be ${KEY_BYTES} bytes (256 bits) ` +
        `or 64 hex characters; got ${key.length} bytes.`,
    );
  }
  return key;
}

/**
 * Names a key by its digest.
 *
 * Derived rather than assigned, so the same key has the same id whether it
 * arrived through the environment or through the file — which is what lets a
 * key move between the two without its ciphertext losing its referent. The
 * digest is one-way, so the id can sit in plaintext beside the ciphertext
 * without narrowing a search for the key.
 */
function keyId(key: Buffer): string {
  return crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, KEY_ID_LENGTH);
}

/**
 * The parsed key file, cached against its mtime and size.
 *
 * Encryption runs per value, so re-reading and re-parsing this file on every
 * call would put a filesystem read in the middle of a bulk insert. The stat
 * that guards the cache is cheap, and it means editing the file takes effect
 * without a restart.
 */
let fileCache: {
  path: string;
  mtimeMs: number;
  size: number;
  data: KeyFileData | null;
} | null = null;

/** Reads a key file, understanding both the JSON envelope and a bare key. */
function parseKeyFile(raw: string, filePath: string): KeyFileData {
  const trimmed = raw.trim();

  // A file holding nothing but the key is the obvious thing to write by hand,
  // so it is accepted rather than rejected for missing an envelope it did not
  // need. JSON always opens with `{`, so the two cannot be confused.
  if (!trimmed.startsWith("{")) {
    if (!trimmed) {
      throw new Error(`The encryption key file ${filePath} is empty.`);
    }
    return { active: trimmed, retired: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `The encryption key file ${filePath} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const record = parsed as Partial<KeyFileData>;
  if (typeof record?.active !== "string" || !record.active) {
    throw new Error(
      `The encryption key file ${filePath} has no "active" key. Expected ` +
        `{"active": "<key>", "retired": ["<key>"]}, or the key on its own.`,
    );
  }

  const retired = Array.isArray(record.retired) ? record.retired : [];
  for (const key of retired) {
    if (typeof key !== "string") {
      throw new Error(
        `The encryption key file ${filePath} has a non-string entry in "retired".`,
      );
    }
  }
  return { active: record.active, retired };
}

/** Reads the key file, or `null` when there is no file at that path. */
function loadKeyFile(filePath: string): KeyFileData | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache = { path: filePath, mtimeMs: 0, size: 0, data: null };
    return null;
  }

  if (
    fileCache &&
    fileCache.path === filePath &&
    fileCache.mtimeMs === stat.mtimeMs &&
    fileCache.size === stat.size
  ) {
    return fileCache.data;
  }

  const data = parseKeyFile(fs.readFileSync(filePath, "utf8"), filePath);
  fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, data };
  return data;
}

/**
 * Creates the key file, or reads the one another process just created.
 *
 * `wx` makes creation and the existence check one step, so two processes
 * starting together cannot both decide they are the first — the loser gets
 * `EEXIST` and reads the winner's key instead of overwriting it. Anything else
 * is rethrown, because a key that could not be written down must not be used.
 */
function createKeyFile(filePath: string): KeyFileData {
  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(
      `Cannot create the directory ${directory} for the encryption key file: ` +
        `${(error as Error).message}. Set ${KEY_ENV_VAR} instead, so no file is needed.`,
    );
  }

  const generated = crypto.randomBytes(KEY_BYTES).toString("hex");
  const data: KeyFileData = { active: generated, retired: [] };

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return parseKeyFile(fs.readFileSync(filePath, "utf8"), filePath);
    }
    throw new Error(
      `Cannot write the encryption key file ${filePath}: ${(error as Error).message}. ` +
        `A generated key that is not stored would make every value encrypted with ` +
        `it unreadable at the next restart, so this is fatal rather than silent. ` +
        `Set ${KEY_ENV_VAR} instead, so no file is needed.`,
    );
  }

  // Worth surfacing: a key that was generated rather than supplied is a fact
  // about the deployment, and the path it landed in has to survive a redeploy.
  process.emitWarning(
    `No ${KEY_ENV_VAR} was set, so an encryption key was generated and stored ` +
      `at ${filePath} with mode 0600. Back it up, and make sure that path ` +
      `survives a redeploy — lose the file and every encrypted value is ` +
      `unreadable. Set ${KEY_ENV_VAR} to supply the key yourself.`,
    { code: "STABILIZE_ENCRYPTION_KEY_GENERATED" },
  );

  return data;
}

/**
 * Assembles the keys available right now.
 *
 * Read on every call rather than captured at module load, so an application
 * that sets the variable after importing still gets it. Only the key file is
 * cached, and only until it changes.
 */
function resolveKeyring(): Keyring {
  const filePath = process.env[KEY_FILE_ENV_VAR] || DEFAULT_KEY_FILE;
  let file = loadKeyFile(filePath);

  const configured = process.env[KEY_ENV_VAR];

  // Nothing supplied anywhere: the file is the only way a generated key can
  // outlive the process, so it is created before anything is encrypted.
  if (!configured && !file) {
    file = createKeyFile(filePath);
  }

  const activeSource = configured
    ? { value: configured, where: KEY_ENV_VAR }
    : { value: file!.active, where: filePath };

  if (!activeSource.value) {
    throw new Error(
      `No encryption key is configured. Set ${KEY_ENV_VAR} to ${KEY_BYTES} bytes ` +
        `(or 64 hex characters), or provide a key file at ${filePath}.`,
    );
  }

  const activeKey = parseKey(activeSource.value, activeSource.where);
  const active: RingKey = { id: keyId(activeKey), key: activeKey };

  // Retired keys decrypt and never encrypt. The file is the durable list; the
  // environment variable is for a deployment that keeps its keys in secrets and
  // has no file to put them in.
  const retiredSources: Array<{ value: string; where: string }> = [];
  for (const value of file?.retired ?? []) {
    retiredSources.push({ value, where: `${filePath} (retired)` });
  }
  for (const value of (process.env[RETIRED_KEYS_ENV_VAR] ?? "").split(",")) {
    const trimmed = value.trim();
    if (trimmed) {
      retiredSources.push({ value: trimmed, where: RETIRED_KEYS_ENV_VAR });
    }
  }

  const byId = new Map<string, Buffer>([[active.id, active.key]]);
  const ordered: Buffer[] = [active.key];
  for (const source of retiredSources) {
    const key = parseKey(source.value, source.where);
    const id = keyId(key);
    if (!byId.has(id)) {
      byId.set(id, key);
      ordered.push(key);
    }
  }

  return { active, byId, ordered };
}

/**
 * Encrypts a UTF-8 string with AES-256-GCM.
 *
 * GCM rather than the CBC this used to use: GCM authenticates the ciphertext,
 * so a value that was tampered with or truncated fails to decrypt instead of
 * silently yielding corrupted plaintext.
 *
 * @param text - The plain text to encrypt.
 * @returns `v3:<keyId>:<iv>:<auth tag>:<ciphertext>`, each part Base64 except
 *   the id, which is hex.
 */
export function encrypt(text: string): string {
  const { active } = resolveKeyring();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", active.key, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  return [
    GCM_ID_PREFIX,
    active.id,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * The id of the key new values are encrypted under.
 *
 * Ciphertext names its key, so this is how a caller works out which key a row
 * was written with — and whether a rotation has finished.
 */
export function activeKeyId(): string {
  return resolveKeyring().active.id;
}

/**
 * Decrypts a string produced by {@link encrypt}.
 *
 * Also reads the two formats written by earlier versions: `v2:iv:tag:ciphertext`,
 * and the unauthenticated `iv:ciphertext` before it. Neither names a key, so
 * each is tried against every key in the ring — GCM's authentication tag makes
 * a wrong key a reliable failure rather than a wrong answer, and CBC at least
 * fails its padding. Nothing writes those formats any more.
 *
 * @param text - The encrypted value.
 * @returns The decrypted plain text.
 */
export function decrypt(text: string): string {
  const ring = resolveKeyring();
  const parts = text.split(":");

  if (parts[0] === GCM_ID_PREFIX && parts.length === 5) {
    const [, id, ivPart, tagPart, dataPart] = parts;
    const key = ring.byId.get(id!);
    if (!key) {
      throw new Error(
        `This value was encrypted with the key "${id}", which is not configured. ` +
          `Add it to the "retired" list in the key file, or to ` +
          `${RETIRED_KEYS_ENV_VAR}, to read it.`,
      );
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart!, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagPart!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  if (parts[0] === GCM_PREFIX && parts.length === 4) {
    const [, ivPart, tagPart, dataPart] = parts;
    return decryptWithAnyKey(ring.ordered, (key) => {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivPart!, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tagPart!, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart!, "base64")),
        decipher.final(),
      ]).toString("utf8");
    });
  }

  const [ivPart, dataPart] = parts;
  if (
    parts.length !== 2 ||
    !ivPart ||
    !dataPart ||
    Buffer.from(ivPart, "base64").length !== CBC_IV_LENGTH
  ) {
    throw new Error(
      `Invalid encrypted text format. Expected "${GCM_ID_PREFIX}:keyId:iv:tag:ciphertext", ` +
        `"${GCM_PREFIX}:iv:tag:ciphertext" or "iv:ciphertext".`,
    );
  }

  return decryptWithAnyKey(ring.ordered, (key) => {
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      key,
      Buffer.from(ivPart, "base64"),
    );
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  });
}

/** Runs `attempt` against each key in turn, returning the first that works. */
function decryptWithAnyKey(
  keys: Buffer[],
  attempt: (key: Buffer) => string,
): string {
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return attempt(key);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `This value could not be decrypted with any configured key. It was written ` +
      `under a key that is not in the ring, or it was tampered with. ` +
      `(${(lastError as Error)?.message ?? "no keys configured"})`,
  );
}

/**
 * Forgets the cached key file.
 *
 * The cache is guarded by the file's mtime and size, so this is only needed
 * where a test rewrites a file within the same mtime tick — or replaces one
 * with different contents of an identical size.
 */
export function resetEncryptionKeyCache(): void {
  fileCache = null;
}
