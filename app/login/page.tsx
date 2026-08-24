import Link from "next/link";
import Logo from "../components/Logo";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(0,0,0,.5),0_12px_32px_-16px_rgba(0,0,0,.8)]">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          Log in to Voom
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Placeholder screen — authentication isn&apos;t connected yet.
        </p>

        <form className="mt-6 flex flex-col gap-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-text-2">
              Email
            </span>
            <input
              type="email"
              disabled
              placeholder="you@business.com"
              className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-text placeholder:text-text-3 disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-text-2">
              Password
            </span>
            <input
              type="password"
              disabled
              placeholder="••••••••"
              className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-text placeholder:text-text-3 disabled:opacity-60"
            />
          </label>

          <button
            type="button"
            disabled
            className="voom-grad mt-1 inline-flex h-[46px] w-full items-center justify-center rounded-[11px] text-sm font-semibold text-white opacity-60"
          >
            Log in
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-text-3">
          <Link href="/" className="hover:text-text-2">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
