// Fixed login messages. They live outside actions.ts because a "use server"
// module may only export async functions.
export const INVALID_LOGIN_MESSAGE = "Incorrect email or password.";
export const EMAIL_NOT_CONFIRMED_MESSAGE =
  "Please confirm your email address before logging in. Open the confirmation link we sent you, or request a new one.";
