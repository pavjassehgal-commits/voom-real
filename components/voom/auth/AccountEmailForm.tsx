"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { AUTH_INPUT, AUTH_SUBMIT, AuthAlert, AuthField } from "./AuthFrame";
import { requestPasswordReset, requestVerification, continueRecovery, changeRecoveredPassword, type AccountEmailState } from "@/app/forgot-password/actions";
function Submit({ children }: {
    children: React.ReactNode;
}) { const { pending } = useFormStatus(); return <button className={AUTH_SUBMIT} disabled={pending}>{pending ? "Please wait…" : children}</button>; }
export function AccountEmailForm({ kind }: {
    kind: "reset" | "verify";
}) {
    const [state, action] = useActionState(kind === "reset" ? requestPasswordReset : requestVerification, {} as AccountEmailState);
    return <div className="mt-6">{state.success ? <p role="status" className="text-sm leading-relaxed text-text-2">{state.message}</p> : <form action={action} className="flex flex-col gap-4">
    {state.error && <AuthAlert>{state.error}</AuthAlert>}<AuthField label="Email" icon="mail" errorId="email-error"><input name="email" type="email" required maxLength={254} autoComplete="email" className={AUTH_INPUT}/></AuthField>
    <Submit>{kind === "reset" ? "Send reset link" : "Send confirmation link"}</Submit></form>}
    <Link href="/login" className="mt-6 block text-center text-sm font-semibold text-[var(--brand)]">Back to log in</Link></div>;
}
export function RecoveryConfirmation({ code, tokenHash, flowId }: {
    code: string;
    tokenHash: string;
    flowId: string;
}) {
    const [state, action] = useActionState(continueRecovery, {} as AccountEmailState);
    return <form action={action} className="mt-6 flex flex-col gap-4">{state.error && <AuthAlert>{state.error}</AuthAlert>}
    <input type="hidden" name="code" value={code}/><input type="hidden" name="token_hash" value={tokenHash}/><input type="hidden" name="sb_flow_id" value={flowId}/>
    <p className="text-sm leading-relaxed text-text-2">Continue to verify your reset link and choose a new password. Opening this page alone does not consume the link.</p><Submit>Continue securely</Submit>
    <Link href="/forgot-password" className="text-center text-sm text-[var(--brand)]">Request a new reset link</Link></form>;
}
export function NewPasswordForm() {
    const [state, action] = useActionState(changeRecoveredPassword, {} as AccountEmailState);
    return <form action={action} className="mt-6 flex flex-col gap-4">{state.error && <AuthAlert>{state.error}</AuthAlert>}
    <AuthField label="New password" icon="lock" errorId="password-error"><input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={AUTH_INPUT}/></AuthField>
    <AuthField label="Confirm new password" icon="lock" errorId="confirm-password-error"><input name="confirmPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={AUTH_INPUT}/></AuthField><Submit>Update password</Submit>
  </form>;
}
