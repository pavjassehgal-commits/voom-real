import { createElement, type ReactNode } from "react";

export default function Link({ href, children, ...rest }: { href: string; children: ReactNode; [key: string]: unknown }) {
  return createElement("a", { href, ...rest }, children);
}
