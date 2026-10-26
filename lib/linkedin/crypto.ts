import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Same AES-256-GCM vault pattern as existing providers, but with a separate
// LinkedIn key and owner-bound authenticated data. No provider keys are reused.
const keyFor = (secret: string) => createHash("sha256").update("voom-linkedin-v1\0").update(secret).digest();
export function encryptLinkedInToken(token: string, secret: string, owner: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(Buffer.from(owner));
  const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(":");
}
export function decryptLinkedInToken(envelope: string, secret: string, owner: string): string {
  try {
    const [version, iv, tag, bytes, extra] = envelope.split(":");
    if (version !== "v1" || !iv || !tag || !bytes || extra) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(iv, "base64url"));
    cipher.setAAD(Buffer.from(owner));
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([cipher.update(Buffer.from(bytes, "base64url")), cipher.final()]).toString("utf8");
  } catch { throw new Error("linkedin_token_unavailable"); }
}
