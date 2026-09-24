import type { ReactNode } from "react";
import { Providers } from "@/app/app/Providers";
import { AppShell, PageHead } from "@/components/voom/shell/AppShell";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { Card, EmptyState, Tag } from "@/components/voom/ui/primitives";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import type { BusinessRecord } from "@/lib/voom/types";

/**
 * Test-only fixture: the REAL shell (sidebar, topbar, workspace, bottom bar)
 * with the REAL Today-style page head, rendered from real account state.
 *
 * Nothing here re-implements layout — every wrapper, the automation control and
 * the copy come from the shipped components, so a measurement taken from this
 * fixture is a measurement of the product surface at the given viewport.
 */
export function businessRecord(overrides: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    owner_user_id: "00000000-0000-4000-8000-000000000002",
    brand_name: "Ada Analytics",
    brand_description: "Analytics for independent retailers.",
    industry: "Retail",
    target_customer: ["store owners"],
    main_goal: "more signups",
    brand_personality: ["direct"],
    preferred_channels: ["instagram"],
    monthly_ad_budget: "500",
    content_frequency: "weekly",
    automation_level: "manual",
    publishing_permission: "approve_each_post",
    plan: "free",
    onboarding_completed: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function TodaySurface({
  plan = "free",
  automationLevel = "manual",
  controlPlan,
  children,
}: {
  plan?: string;
  automationLevel?: string | null;
  /**
   * Mode-control plan. Today renders the control without a plan prop (so it
   * falls back to Free, exactly as shipped); the Automations screen passes the
   * account plan. Tests that need to change mode on a paid account set this.
   */
  controlPlan?: "free" | "pro" | "max";
  children?: ReactNode;
}) {
  const business = businessRecord({ plan, automation_level: automationLevel ?? null });
  return (
    <Providers initialDisplayName="Ada Lovelace" initialEmail="ada@example.com" initialBusiness={business}>
      <AppShell>
        <PageHead
          title="Today"
          description="Weekly plan · Asia Kolkata · 24 September 2026"
          actions={<AutomationMode compact initial={normalizeAutomationMode(automationLevel)} plan={controlPlan} />}
        />
        <Card className="mb-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">What Voom is doing today, Ada</h2>
            <Tag tone="t-blue">Plan on track</Tag>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text-2">
            3 items due today · 2 waiting for you · 1 generating · 0 waiting for media · 0 needing attention.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              ["Due today", 3],
              ["Needs approval", 2],
              ["Generating", 1],
              ["Scheduled", 4],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
                <div className="font-display text-2xl leading-none">{value}</div>
                <span className="text-[11.5px] text-text-3">{label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="mb-4 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="font-display text-base font-semibold">Needs your approval</h2>
            <Tag tone="t-grey">2</Tag>
          </div>
          <EmptyState title="Nothing needs your decision right now." reason="Voom prepares work and brings it here before it schedules anything, so you always decide what goes out." />
        </Card>
        {children}
      </AppShell>
    </Providers>
  );
}
