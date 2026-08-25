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
      className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(7,9,18,.55)] p-5 backdrop-blur-[5px]"
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
      className="max-h-[88dvh] w-full overflow-y-auto rounded-[22px] border border-line bg-surface shadow-[var(--shadow-lg)]"
      style={{ maxWidth: maxWidth ?? (wide ? 620 : 480) }}
    >
      {children}
    </div>
  );
}

export function ModalHead({ title, sub, onClose }: { title: ReactNode; sub?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3.5 px-[22px] pt-5">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[13px] text-text-3">{sub}</p>}
      </div>
      <IconBtn onClick={onClose}>
        <Icon name="x" />
      </IconBtn>
    </div>
  );
}

export function ModalBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("px-[22px] py-4", className)}>{children}</div>;
}

export function ModalFoot({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex flex-wrap justify-end gap-2.5 px-[22px] pb-5 pt-3.5", className)}>{children}</div>;
}
