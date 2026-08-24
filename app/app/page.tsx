import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import Logo from "../components/Logo";
import { logout } from "./actions";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <Logo />
        <form action={logout}>
          <button
            type="submit"
            className="text-sm font-medium text-text-2 hover:text-text"
          >
            Log out
          </button>
        </form>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <div className="mb-8 flex items-center gap-3 rounded-2xl border border-line bg-surface p-5">
          <span className="relative h-11 w-11 flex-none rounded-full bg-[conic-gradient(from_200deg,#e8481f,#f2a516,#0f6f68,#e8481f)] shadow-[0_0_0_3px_var(--surface)]">
            <span className="absolute inset-[7px] rounded-full bg-surface" />
            <span className="voom-grad absolute inset-[11px] rounded-full" />
          </span>
          <div>
            <p className="font-display text-base font-semibold">
              Hi, I&apos;m MARA
            </p>
            <p className="text-sm text-text-2">
              Your dashboard is being wired up — this is a placeholder view.
            </p>
          </div>
        </div>

        <h1 className="font-display text-2xl font-bold tracking-tight">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Campaign performance will appear here once your business is
          connected.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: "Reach", value: "—" },
            { label: "Engagement rate", value: "—" },
            { label: "New followers", value: "—" },
            { label: "Attributed revenue", value: "—" },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <p className="text-xs font-medium text-text-2">{kpi.label}</p>
              <p className="mt-2 font-display text-2xl font-bold tracking-tight text-text-3">
                {kpi.value}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
