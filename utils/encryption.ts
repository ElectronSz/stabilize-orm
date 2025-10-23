import crypto from "crypto";

const ENCRYPTION_KEY =
    process.env.ORM_ENCRYPTION_KEY || "f71a3c8e9b12d5a49c0a3f98b1f2e46d"; // 32 bytes for AES-256
const IV_LENGTH = 16; // AES block size in bytes

/**
 * Encrypts a UTF-8 string using AES-256-CBC.
 * @param text - The plain text to encrypt.
 * @returns {string} Base64-encoded string in the format "iv:encrypted".
 */
export function encrypt(text: string): string {
    // Convert the encryption key properly (handle hex vs utf8)
    const keyBuffer = Buffer.from(ENCRYPTION_KEY, "utf8");
    if (keyBuffer.length !== 32) {
        throw new Error("ENCRYPTION_KEY must be 32 bytes (256 bits) long for AES-256");
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", keyBuffer, iv);

    const encrypted = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
    ]);

    return `${iv.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a string encrypted with `encrypt()`.
 * @param text - The Base64-encoded "iv:encrypted" string.
 * @returns {string} The decrypted plain text.
 */
export function decrypt(text: string): string {
    const [ivPart, encryptedPart] = text.split(":");
    if (!ivPart || !encryptedPart) {
        throw new Error("Invalid encrypted text format. Expected 'iv:encrypted'.");
    }

    const iv = Buffer.from(ivPart, "base64");
    const encrypted = Buffer.from(encryptedPart, "base64");

    const keyBuffer = Buffer.from(ENCRYPTION_KEY, "utf8");
    if (keyBuffer.length !== 32) {
        throw new Error("ENCRYPTION_KEY must be 32 bytes (256 bits) long for AES-256");
    }

    const decipher = crypto.createDecipheriv("aes-256-cbc", keyBuffer, iv);
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
}
