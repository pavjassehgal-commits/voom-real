"use client";

import type { ReactNode } from "react";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { IconBtn, cx } from "./primitives";

export function ModalHost() {
  const { content, close } = useModal();
  if (!content) return null;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(10,14,13,0.52)] p-4 backdrop-blur-[6px] sm:p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {content}
    </div>
  );
}

export function ModalShell({
  wide,
  maxWidth,
  children,
}: {
  wide?: boolean;
  maxWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="max-h-[88dvh] w-full overflow-y-auto rounded-[20px] border border-line bg-surface shadow-[var(--shadow-lg)]"
      style={{ maxWidth: maxWidth ?? (wide ? 640 : 480) }}
    >
      {children}
    </div>
  );
}

export function ModalHead({ title, sub, onClose }: { title: ReactNode; sub?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-6">
      <div className="min-w-0">
        <h2 className="font-display text-[18px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[13px] leading-relaxed text-text-3">{sub}</p>}
      </div>
      <IconBtn onClick={onClose} className="!h-8 !w-8 rounded-[9px] border border-line bg-surface-2">
        <Icon name="x" size={14} />
      </IconBtn>
    </div>
  );
}

export function ModalBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("px-6 py-4", className)}>{children}</div>;
}

export function ModalFoot({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex flex-wrap justify-end gap-2.5 border-t border-line bg-surface-2/60 px-6 py-4", className)}>{children}</div>;
}
