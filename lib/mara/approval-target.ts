/** Legacy MARA card routing; never authorizes publishing or creates content. */
export function draftApprovalTarget(kind: string, draftId: string) {
  if (["instagram_post", "reel", "story"].includes(kind)) return null;
  if (["tiktok_video", "youtube_short", "youtube_video"].includes(kind)) {
    const platform = kind === "tiktok_video" ? "TikTok" : "YouTube";
    return { href: `/app/content/${encodeURIComponent(draftId)}`, label: `Open ${platform} editor`, reason: `Review this video in its ${platform} editor and confirm the required platform settings. This legacy MARA card cannot grant publishing consent.` };
  }
  if (kind === "linkedin_text") return { href: `/app/linkedin?draft=${encodeURIComponent(draftId)}`, label: "Open LinkedIn editor", reason: "Review this post in the LinkedIn editor and confirm its publishing settings there. This MARA card cannot approve it." };
  if (kind === "email") return { href: "/app/campaigns", label: "Open Campaigns", reason: "This is a legacy MARA email draft. This card cannot approve or send it. Review an email campaign in Campaigns; sending still requires its own confirmation." };
  return { href: "/app/plan", label: "View plan", reason: "This is a legacy planning or unsupported draft, not a publishable post. This card cannot approve it. Review the plan or use the current content editor." };
}
