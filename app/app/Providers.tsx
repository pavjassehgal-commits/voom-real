"use client";

import type { ReactNode } from "react";
import { VoomProvider } from "@/lib/voom/store";
import { ModalProvider } from "@/lib/voom/modal";
import { ModalHost } from "@/components/voom/ui/Modal";
import { ToastHost } from "@/components/voom/ui/ToastHost";
import type { BusinessRecord } from "@/lib/voom/types";

export function Providers({
  children,
  initialDisplayName,
  initialEmail,
  initialBusiness,
}: {
  children: ReactNode;
  initialDisplayName: string | null;
  initialEmail: string | null;
  initialBusiness: BusinessRecord | null;
}) {
  return (
    <VoomProvider initialDisplayName={initialDisplayName} initialEmail={initialEmail} initialBusiness={initialBusiness}>
      <ModalProvider>
        {children}
        <ModalHost />
        <ToastHost />
      </ModalProvider>
    </VoomProvider>
  );
}
