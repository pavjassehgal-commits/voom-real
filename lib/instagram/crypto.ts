import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function deriveKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptInstagramToken(token: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    encryptedToken: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptInstagramToken(input: { encryptedToken: string; iv: string; authTag: string }, secret: string) {
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(input.encryptedToken, "base64")), decipher.final()]).toString("utf8");
}
