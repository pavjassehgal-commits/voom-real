import { validCode, validFlowId } from "./policy";
import type { RecoveryCode } from "./flows";

export const RECOVERY_COOKIE = "voom_recovery_code";
export const recoveryCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 600,
};
export function readRecoveryCode(value: string | undefined): RecoveryCode | null {
  if (!value || value.length > 3000) return null;
  try {
    const parsed = JSON.parse(value);
    if (!validCode(parsed?.code) || (parsed.flowId != null && !validFlowId(parsed.flowId))) return null;
    return { code: parsed.code, ...(parsed.flowId ? { flowId: parsed.flowId } : {}) };
  } catch { return null; }
}
