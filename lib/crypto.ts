import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for secrets stored in the database (WhatsApp tokens, etc.).
// Stored format: "v1.<iv>.<authTag>.<ciphertext>", each part base64.

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(12); // 96-bit nonce, the recommended size for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new Error("Unrecognised encrypted secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // final() throws if the data was tampered with or the key is wrong.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
