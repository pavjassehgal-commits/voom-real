import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { VoomLogo } from "@/components/voom/shell/VoomLogo";

/**
 * Public homepage — redesign Batch 4A (Figma "voom · Marketing that runs
 * itself", Keep).
 *
 * The hero artwork is the reference's own image. The copy names only the
 * channels Voom publishes to today (the reference also lists Facebook, which
 * Voom does not support), and every button leads to a real route.
 */
export default function Home() {
  return (
    <div className="voom-public relative flex min-h-dvh flex-col overflow-hidden">
      {/* Desktop: the artwork fills the page behind header and footer, framed as in the reference. */}
      <Image
        src="/redesign/landing-hero.webp"
        alt=""
        fill
        priority
        sizes="100vw"
        className="hidden origin-[108%_100%] scale-[1.14] object-cover object-bottom md:block"
      />
      <header className="relative z-20 border-b border-[var(--line)] bg-white/70 backdrop-blur-[12px]">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Voom home" className="rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]">
            <VoomLogo size={32} />
          </Link>
          <nav className="flex items-center gap-2 sm:gap-3" aria-label="Account">
            <Link href="/login" className="inline-flex h-10 items-center rounded-[10px] border border-[var(--line)] bg-white px-4 text-[14px] font-medium text-text transition hover:bg-[var(--surface-2)]">
              Log in
            </Link>
            <Link href="/signup" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[#161a2e] px-4 text-[14px] font-semibold text-white transition hover:bg-[#232843]">
              <span className="sm:hidden">Get started</span>
              <span className="hidden sm:inline">Get started for free</span>
              <Icon name="arrow" size={14} />
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative flex flex-1 flex-col">
        <div className="voom-setup-wash absolute inset-0 md:hidden" aria-hidden="true" />

        <section className="relative z-10 mx-auto flex w-full max-w-[860px] flex-col items-center px-5 pb-8 pt-14 text-center sm:pt-20 md:pt-24">
          <h1 className="text-[clamp(2.4rem,7vw,4.25rem)] font-bold leading-[1.02] tracking-[-0.045em] text-text">
            Marketing that <span className="voom-brand-text">runs itself.</span>
          </h1>
          <p className="mt-5 max-w-[620px] text-[17px] leading-[1.45] text-text-2 sm:text-[21px]">
            Plan, create, schedule, and publish content across Instagram, TikTok, YouTube and email, all from one workspace.
          </p>
          <Link
            href="/signup"
            className="voom-create-btn mt-7 inline-flex h-[50px] items-center gap-3 rounded-[10px] px-7 text-[15px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(134,69,250,.8)] transition hover:brightness-[1.05]"
          >
            Get started for free <Icon name="arrow" size={15} />
          </Link>
        </section>

        {/* Mobile: the same artwork as a framed image below the headline. */}
        <div className="relative z-10 mx-4 mb-6 aspect-[3/2] overflow-hidden rounded-[20px] md:hidden">
          <Image src="/redesign/landing-hero.webp" alt="" fill sizes="100vw" className="object-cover object-[55%_70%]" />
        </div>
        <div className="hidden flex-1 md:block md:min-h-[380px]" aria-hidden="true" />
      </main>

      <footer className="relative z-20 border-t border-white/60 bg-white/65 backdrop-blur-[10px]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-3 px-5 py-5 text-[14px] text-text-2 sm:flex-row sm:px-6">
          <span>Voom - Automated Marketing Platform</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-8 gap-y-1" aria-label="Legal">
            <Link href="/privacy" className="transition hover:text-text">Privacy Policy</Link>
            <Link href="/terms" className="transition hover:text-text">Terms of Service</Link>
            <Link href="/data-deletion" className="transition hover:text-text">Data Deletion</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
