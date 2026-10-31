import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { VoomLogo } from "@/components/voom/shell/VoomLogo";

/**
 * Public homepage.
 *
 * Hero photograph: the reference's own artwork, served as the ORIGINAL bytes
 * exported from the Figma file (public/redesign/landing-hero.jpg, 1536×1024,
 * the highest resolution that exists). `unoptimized` keeps Next from
 * re-encoding it, and it is framed in a card no wider than 980px (≥1.5 source
 * pixels per CSS pixel) instead of being stretched across the page. The empty
 * pastel top of the photo is cropped away by the card's aspect ratio.
 *
 * Motion is CSS-only (`.voom-home` in app/globals.css): the page is fully
 * visible without JavaScript, nothing changes layout, and every animation is
 * removed under prefers-reduced-motion.
 *
 * The copy names only the channels Voom publishes to today, and every button
 * leads to a real route.
 */
export default function Home() {
  return (
    <div className="voom-public voom-home relative flex min-h-dvh flex-col overflow-x-clip">
      <div className="voom-home-wash pointer-events-none absolute inset-x-0 top-0 h-[880px]" aria-hidden="true" />

      <header className="voom-home-in voom-home-header sticky top-0 z-30 border-b border-[var(--line)]/70 bg-white/72 backdrop-blur-[14px]">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Voom home" className="voom-home-focus rounded-[10px]">
            <VoomLogo size={32} />
          </Link>
          <nav className="flex shrink-0 items-center gap-2 sm:gap-3" aria-label="Account">
            <Link href="/login" className="voom-home-btn voom-home-focus inline-flex h-10 items-center whitespace-nowrap rounded-full border border-[var(--line)] bg-white/90 px-3.5 text-[14px] min-[360px]:px-4 font-medium text-text hover:border-[var(--line-2)] hover:bg-white">
              Log in
            </Link>
            <Link href="/signup" className="voom-home-btn voom-home-focus group inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full bg-[#161a2e] px-3.5 text-[14px] min-[360px]:px-4 font-semibold text-white hover:bg-[#232843]">
              <span className="sm:hidden">Get started</span>
              <span className="hidden sm:inline">Get started for free</span>
              <Icon name="arrow" size={14} className="voom-home-arrow hidden min-[360px]:block" />
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col">
        <section className="mx-auto flex w-full max-w-[880px] flex-col items-center px-5 pb-10 pt-14 text-center sm:pt-20 md:pt-24" aria-labelledby="home-title">
          <h1 id="home-title" className="text-[clamp(2.5rem,7.2vw,4.6rem)] font-bold leading-[1.02] tracking-[-0.045em] text-text">
            <span className="voom-home-in voom-home-title inline-block">Marketing that</span>{" "}
            <span className="voom-home-in voom-home-gradient voom-brand-text inline-block">runs itself.</span>
          </h1>
          <p className="voom-home-in voom-home-sub mt-5 max-w-[620px] text-[17px] leading-[1.5] text-text-2 sm:text-[20px]">
            Plan, create, schedule, and publish content across Instagram, TikTok, YouTube and email, all from one workspace.
          </p>
          <div className="voom-home-in voom-home-cta mt-8">
            <Link
              href="/signup"
              className="voom-home-btn voom-home-focus voom-create-btn group inline-flex h-[52px] items-center gap-3 rounded-full px-7 text-[15.5px] font-semibold text-white shadow-[0_12px_28px_-14px_rgba(134,69,250,.85)] hover:shadow-[0_18px_34px_-14px_rgba(134,69,250,.95)]"
            >
              Get started for free <Icon name="arrow" size={16} className="voom-home-arrow" />
            </Link>
          </div>
        </section>

        <div className="mx-auto w-full max-w-[1012px] px-4 pb-14 sm:px-6 sm:pb-20">
          <figure className="voom-home-in voom-home-hero relative aspect-[16/10] overflow-hidden rounded-[22px] bg-[#eceaf8] shadow-[0_40px_80px_-48px_rgba(44,38,92,.55),0_0_0_1px_rgba(44,38,92,.06)] sm:aspect-[2.35/1] sm:rounded-[28px]">
            <Image
              src="/redesign/landing-hero.jpg"
              alt=""
              fill
              priority
              unoptimized
              sizes="(min-width: 1012px) 980px, 100vw"
              className="voom-home-hero-img object-cover object-[60%_100%] sm:object-bottom"
            />
          </figure>
        </div>
      </main>

      <footer className="relative z-10 border-t border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-3 px-5 py-6 text-[14px] text-text-2 sm:flex-row sm:px-6">
          <span>Voom - Automated Marketing Platform</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-8 gap-y-1" aria-label="Legal">
            <Link href="/privacy" className="voom-home-focus rounded transition-colors hover:text-text">Privacy Policy</Link>
            <Link href="/terms" className="voom-home-focus rounded transition-colors hover:text-text">Terms of Service</Link>
            <Link href="/data-deletion" className="voom-home-focus rounded transition-colors hover:text-text">Data Deletion</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
