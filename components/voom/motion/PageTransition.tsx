"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Animates PAGE CONTENT (never the shell) when the owner moves between
 * workspace routes.
 *
 * - The first, server-rendered page is never hidden: the entrance class is
 *   only added after a client-side route change, so content that arrived as
 *   HTML is visible before and without hydration.
 * - Re-keyed per pathname so each new page plays the entrance once; a
 *   re-render of the same page (data refresh, revalidation) does not replay it.
 * - Transform + opacity only, 300ms with a short capped stagger
 *   (`.voom-page-enter` in app/globals.css); collapsed to instant under
 *   reduced motion. Scroll position and focus are left to Next.js.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const first = useRef(pathname);
  const [navigated, setNavigated] = useState(false);

  useEffect(() => {
    if (pathname !== first.current) setNavigated(true);
  }, [pathname]);

  return (
    <div key={pathname} className={navigated ? "voom-page-enter w-full flex-1" : "w-full flex-1"}>
      {children}
    </div>
  );
}
