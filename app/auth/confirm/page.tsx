import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import { EmailConfirmation } from "@/components/voom/auth/AccountEmailForm";
export const metadata = { title: "Confirm your email | Voom", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";
// Opening this page never consumes the link (mail scanners prefetch GETs); the
// button posts the token hash to a server action that verifies it once.
export default async function ConfirmEmailPage({ searchParams }: {
    searchParams: Promise<{
        token_hash?: string;
    }>;
}) {
    const query = await searchParams;
    return <AuthFrame title="Confirm your email"><EmailConfirmation tokenHash={String(query.token_hash || "").slice(0, 257)}/></AuthFrame>;
}
