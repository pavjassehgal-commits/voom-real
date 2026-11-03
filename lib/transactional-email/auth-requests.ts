export const AUTH_EMAIL_MESSAGE = "If this address is eligible, you’ll receive an email with the next steps. Check your inbox and spam folder.";
export async function requestAuthEmail(allowed: () => Promise<boolean>, send: () => Promise<unknown>) {
    // Same response for unknown accounts, throttling and provider failures.
    // Never inspect an account using service-role/admin APIs.
    try {
        if (await allowed())
            await send();
    }
    catch { /* no account/provider details in the public response */ }
    return { success: true, message: AUTH_EMAIL_MESSAGE };
}
export function validAuthEmail(email: string) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
