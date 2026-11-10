import { AuthFrame } from "@/components/voom/auth/AuthFrame";
import { RecoveryConfirmation } from "@/components/voom/auth/AccountEmailForm";
export const metadata = { title: "Secure password recovery | Voom", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";
export default async function RecoveryPage({ searchParams }: {
    searchParams: Promise<{
        code?: string;
        token_hash?: string;
        sb_flow_id?: string;
    }>;
}) {
    const query = await searchParams;
    return <AuthFrame title="Recover your account"><RecoveryConfirmation code={String(query.code || "").slice(0, 2049)} tokenHash={String(query.token_hash || "").slice(0, 257)} flowId={String(query.sb_flow_id || "").slice(0, 129)}/></AuthFrame>;
}
