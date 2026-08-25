"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface ModalCtxValue {
  content: ReactNode | null;
  open: (content: ReactNode) => void;
  close: () => void;
}

const ModalCtx = createContext<ModalCtxValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode | null>(null);
  const open = useCallback((c: ReactNode) => setContent(c), []);
  const close = useCallback(() => setContent(null), []);
  return <ModalCtx.Provider value={{ content, open, close }}>{children}</ModalCtx.Provider>;
}

export function useModal() {
  const ctx = useContext(ModalCtx);
  if (!ctx) throw new Error("useModal must be used inside ModalProvider");
  return ctx;
}
