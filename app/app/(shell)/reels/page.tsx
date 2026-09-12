import { redirect } from "next/navigation";

/**
 * The old "Content Studio" page was a sample workspace with illustration-only
 * data. It was removed from the product: the real Reel workflow lives under
 * Approvals and all real content lives in Create Content, so this route now
 * forwards there. No dead link, no demo UI.
 */
export default function ReelsRedirectPage() {
  redirect("/app/studio");
}
