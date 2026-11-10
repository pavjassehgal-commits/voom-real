export const AUTH_EMAIL_MESSAGE = "If this address is eligible, you’ll receive an email with the next steps. Check your inbox and spam folder.";
export async function requestAuthEmail(allowed: () => Promise<"allowed" | "limited" | "unavailable">, send: () => Promise<unknown>) {
    // Same response for unknown accounts, throttling and provider failures.
    // Never inspect an account using service-role/admin APIs.
    let result: "allowed" | "limited" | "unavailable";
    try { result = await allowed(); }
    catch { result = "unavailable"; }
    if (result === "unavailable") return { error: "This service is temporarily unavailable. Please try again later." };
    if (result === "allowed") {
        try { await send(); }
        catch { /* no account/provider details in the public response */ }
    }
    return { success: true, message: AUTH_EMAIL_MESSAGE };
}
export function validAuthEmail(email: string) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
