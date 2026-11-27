import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const value = process.env.ENCRYPTION_KEY?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error("ENCRYPTION_KEY must be 32 bytes of hex (64 characters) — generate one with `openssl rand -hex 32`");
  return Buffer.from(value, "hex");
}

/** Lets a process that stores tokens fail at startup rather than on its first token write. */
export function assertEncryptionKey(): void {
  key();
}

export function encrypt(value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value");
  const [iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer];
  // A full-length tag is required: GCM would otherwise accept a truncated, far easier to forge, tag.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
