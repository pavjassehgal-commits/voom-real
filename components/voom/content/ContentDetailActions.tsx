"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/voom/icons";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN } from "@/components/voom/redesign/ui";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";

/**
 * Post-detail actions. Edit, Reschedule and Replace all open the existing
 * editor for this post — the one place that enforces approval, schedule and
 * media rules — and refresh the detail when it reports a change.
 */
export function ContentDetailActions({ id, editor, canReschedule = true, variant = "header" }: {
  id: string;
  editor: "post" | "social";
  canReschedule?: boolean;
  variant?: "header" | "replace";
}) {
  const router = useRouter();
  const { open } = useModal();
  const openEditor = () => {
    const onChanged = () => router.refresh();
    open(editor === "social" ? <SocialEditorModal draftId={id} onChanged={onChanged} /> : <PostEditorModal postId={id} onChanged={onChanged} />);
  };
  if (variant === "replace") {
    return <button type="button" onClick={openEditor} className="shrink-0 font-semibold text-[var(--brand-ink)] hover:underline">Replace media</button>;
  }
  return (
    <div className="flex flex-wrap gap-2.5">
      {canReschedule && <button type="button" onClick={openEditor} className={cx(BTN.quiet, "rounded-full")}><Icon name="cal" size={15} /> Reschedule</button>}
      <button type="button" onClick={openEditor} className={BTN.primary}><Icon name="pencil" size={15} /> Edit post</button>
    </div>
  );
}
