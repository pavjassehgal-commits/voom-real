import Link from "next/link";
import { AuthAlert } from "@/components/voom/auth/AuthFrame";

/**
 * The login form's error. When the account's email isn't confirmed yet, it
 * also links to the existing /verify-email page. That page asks for the
 * address again and always answers neutrally, so this link reveals nothing.
 */
export function LoginAlert({ message, unconfirmed }: { message: string; unconfirmed?: boolean }) {
  return (
    <AuthAlert>
      {message}
      {unconfirmed && (
        <>
          {" "}
          <Link href="/verify-email" className="font-semibold underline">
            Send a new confirmation link
          </Link>
        </>
      )}
    </AuthAlert>
  );
}
