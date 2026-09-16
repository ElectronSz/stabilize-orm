import crypto from "crypto";

/**
 * The environment variable that holds the encryption key.
 *
 * There is deliberately no default. The key used to fall back to a constant
 * written into this file, so every deployment that never set the variable
 * encrypted its columns with a value anyone who read the published package
 * could reproduce — data that looked confidential and offered none of the
 * protection. A missing key is a deployment mistake, and it now fails loudly
 * instead of quietly protecting nothing.
 */
const KEY_ENV_VAR = "ORM_ENCRYPTION_KEY";

/** The key previously hard-coded here, kept only to explain the migration. */
const LEGACY_KEY = "f71a3c8e9b12d5a49c0a3f98b1f2e46d";

/** IV length for AES-GCM, which is what `encrypt` writes today. */
const GCM_IV_LENGTH = 12;
/** AES block size — the IV length of the legacy CBC format. */
const CBC_IV_LENGTH = 16;
/** Prefix identifying the authenticated format. */
const GCM_PREFIX = "v2";

/**
 * Resolves the configured key.
 *
 * Read on every call rather than captured at module load, so an application
 * that sets the variable after importing still gets it.
 */
function getKey(): Buffer {
  const configured = process.env[KEY_ENV_VAR];
  if (!configured) {
    throw new Error(
      `${KEY_ENV_VAR} is not set, so encrypted columns cannot be read or written. ` +
        `Set it to 32 bytes (or 64 hex characters). Data written before this check ` +
        `existed used a hard-coded key: set ${KEY_ENV_VAR}="${LEGACY_KEY}" to keep ` +
        `reading it, then re-save those rows under a key of your own.`,
    );
  }

  const key = /^[0-9a-fA-F]{64}$/.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "utf8");

  if (key.length !== 32) {
    throw new Error(
      `${KEY_ENV_VAR} must be 32 bytes (256 bits) or 64 hex characters; got ${key.length} bytes.`,
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 string with AES-256-GCM.
 *
 * GCM rather than the CBC this used to use: GCM authenticates the ciphertext,
 * so a value that was tampered with or truncated fails to decrypt instead of
 * silently yielding corrupted plaintext.
 *
 * @param text - The plain text to encrypt.
 * @returns `v2:<iv>:<auth tag>:<ciphertext>`, each part Base64.
 */
export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  return [
    GCM_PREFIX,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypts a string produced by {@link encrypt}.
 *
 * Also reads the unauthenticated `iv:ciphertext` CBC format written by earlier
 * versions, so existing rows stay readable. Nothing writes that format any
 * more.
 *
 * @param text - The encrypted value.
 * @returns The decrypted plain text.
 */
export function decrypt(text: string): string {
  const key = getKey();
  const parts = text.split(":");

  if (parts[0] === GCM_PREFIX && parts.length === 4) {
    const [, ivPart, tagPart, dataPart] = parts;
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

  const [ivPart, dataPart] = parts;
  if (
    parts.length !== 2 ||
    !ivPart ||
    !dataPart ||
    Buffer.from(ivPart, "base64").length !== CBC_IV_LENGTH
  ) {
    throw new Error(
      `Invalid encrypted text format. Expected "${GCM_PREFIX}:iv:tag:ciphertext" or "iv:ciphertext".`,
    );
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    key,
    Buffer.from(ivPart, "base64"),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
