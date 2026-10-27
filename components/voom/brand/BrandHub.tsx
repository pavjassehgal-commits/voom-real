"use client";

/**
 * Brand Hub (Brand Kit v2, slice 2).
 *
 * One scrolling page: every section reads as plain paragraphs, Edit turns it
 * into fields in place, Save appends a kit version through the carry-forward
 * rule (only that section's fields change). `mode="onboarding"` is the same
 * component as the last wizard screen (slice 3): it hides History and the
 * operating section and offers "Looks right" instead. "How we sound" can ask
 * MARA for three sample captions to sort (slice 6, `VoiceSamplesWriter`).
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Icon } from "@/components/voom/icons";
import { AutomationMode } from "@/components/voom/operating/AutomationMode";
import { Btn, Card, Chip, Field, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { BrandAssetsEditor } from "@/components/voom/brand/BrandAssetsEditor";
import { requestVoiceSamples, sortSample, VoiceSampleCards, voiceSamplesMessage, WritingSamplesPanel, type SampleVerdict } from "@/components/voom/brand/VoiceSamples";
import { saveBrandSection } from "@/lib/brand/actions";
import { VOICE_SAMPLES_PER_LIST, voiceSnapshotFromSections } from "@/lib/brand/voice";
import { coloursAfterLogo, describeBrandAssets, withAddedAsset, withAssetText, withoutAsset, type BrandAsset } from "@/lib/brand/assets";
import {
  answerKeyLabel, AVOID_RULES, BRAND_SECTIONS, brandSectionMeta, validateBrandSection,
  type BrandKitVersionView, type BrandSectionId, type BrandSectionValues,
} from "@/lib/brand/sections";
import type { PlanId } from "@/lib/billing/plans";
import { AUTOMATION_MODE_EVENT, AUTOMATION_MODE_LABELS, type AutomationModeValue } from "@/lib/voom/automation";
import { OB_TONE, Q_CHANNELS, Q_CUSTOMER, Q_FREQ, Q_GOAL, Q_INDUSTRY } from "@/lib/voom/onboardingData";

export interface BrandHubProps {
  mode: "hub" | "onboarding";
  initialValues: BrandSectionValues;
  history: BrandKitVersionView[];
  plan: PlanId;
  automation: AutomationModeValue;
  /** Onboarding mode only: "Looks right". */
  onDone?: () => void;
  /**
   * Where a Save goes. "server" (default) calls the save action and records a
   * version. "local" keeps the values in memory and reports them through
   * `onLocalSave`: the onboarding wizard uses this because the business row
   * does not exist until "Finish setup", which then writes everything at once.
   */
  persist?: "server" | "local";
  onLocalSave?: (id: BrandSectionId, values: BrandSectionValues[BrandSectionId]) => void;
  /** Slice 5: one-hour preview links for the saved images, by path (signed on the server). */
  assetUrls?: Record<string, string>;
  /** Slice 5: true when MARA's image reading is configured (AI_VISION_*). */
  visionEnabled?: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  onboarding: "Onboarding",
  brand_hub: "Brand page",
  extraction: "MARA's reading",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A list typed as free text (one per line, or comma-separated). The box keeps
 * exactly what the user types, including a trailing comma or newline, and the
 * parsed list is only emitted alongside; re-deriving the text from the list on
 * every keystroke would swallow separators as they are typed.
 */
function ListText({ items, separator, rows, disabled, onChange }: { items: string[]; separator: "line" | "comma"; rows?: number; disabled?: boolean; onChange: (next: string[]) => void }) {
  const join = (list: string[]) => list.join(separator === "line" ? "\n" : ", ");
  const [text, setText] = useState(items.join(separator === "line" ? "\n" : ", "));
  const parse = (value: string) => (separator === "line" ? value.split("\n") : value.split(",")).map((part) => part.trim()).filter(Boolean);
  // A list changed from outside the box (slice 6: a tapped sample caption) replaces the text; the box's own typing never does.
  const [emitted, setEmitted] = useState(join(items));
  if (join(items) !== emitted) {
    setEmitted(join(items));
    setText(join(items));
  }
  const handle = (value: string) => {
    setText(value);
    const next = parse(value);
    setEmitted(join(next));
    onChange(next);
  };
  return separator === "line"
    ? <Textarea rows={rows ?? 4} value={text} disabled={disabled} onChange={(e) => handle(e.target.value)} />
    : <Input value={text} disabled={disabled} onChange={(e) => handle(e.target.value)} />;
}

function Para({ children, empty }: { children?: string | string[]; empty: string }) {
  const value = Array.isArray(children) ? children.join(", ") : children;
  return value ? <p className="whitespace-pre-line text-[14px] leading-relaxed text-text">{value}</p> : <p className="text-[13.5px] text-text-3">{empty}</p>;
}

function ChipList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-[13.5px] text-text-3">{empty}</p>;
  return <div className="flex flex-wrap gap-1.5">{items.map((item) => <Tag key={item} tone="t-brand">{item}</Tag>)}</div>;
}

function Toggle({ options, selected, onChange, disabled }: { options: readonly string[]; selected: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <Chip key={option} active={active} disabled={disabled} onClick={() => onChange(active ? selected.filter((x) => x !== option) : [...selected, option])}>
            {option}
          </Chip>
        );
      })}
    </div>
  );
}

function Pick({ options, value, onChange, disabled }: { options: readonly string[]; value: string; onChange: (next: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <Chip key={option} active={value === option} disabled={disabled} onClick={() => onChange(value === option ? "" : option)}>
          {option}
        </Chip>
      ))}
    </div>
  );
}

export function BrandHub({ mode, initialValues, history, plan, automation, onDone, persist = "server", onLocalSave, assetUrls, visionEnabled = false }: BrandHubProps) {
  const [values, setValues] = useState<BrandSectionValues>(initialValues);
  const [editing, setEditing] = useState<BrandSectionId | null>(null);
  const [draft, setDraft] = useState<BrandSectionValues[BrandSectionId] | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>(assetUrls ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [versions, setVersions] = useState<BrandKitVersionView[]>(history);
  const [openVersion, setOpenVersion] = useState<number | null>(null);

  const sections = useMemo(() => BRAND_SECTIONS.filter((section) => mode === "hub" || !section.hubOnly), [mode]);

  // A mode change on the automation cards (which save themselves) also
  // becomes a kit version, so it shows in History like every other edit.
  useEffect(() => {
    if (mode !== "hub" || typeof window === "undefined") return;
    const handler = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: AutomationModeValue }>).detail?.mode;
      if (!next) return;
      void saveBrandSection("operate", { ...values.operate, automation: next }).then((result) => {
        if (!result.ok) return;
        setValues((prev) => ({ ...prev, operate: { ...prev.operate, automation: next } }));
        setVersions((prev) => [{
          version: result.version, answers: { automation: next }, brief: "", assets: prev[0]?.assets ?? [], source: "brand_hub",
          changeSummary: "What MARA may do updated", changedKeys: ["automation"], createdAt: new Date().toISOString(),
        }, ...prev]);
      });
    };
    window.addEventListener(AUTOMATION_MODE_EVENT, handler);
    return () => window.removeEventListener(AUTOMATION_MODE_EVENT, handler);
  }, [mode, values.operate]);

  function startEdit(id: BrandSectionId) {
    setEditing(id);
    setDraft(structuredClone(values[id]));
    setError("");
    setNotice("");
  }

  function cancelEdit() {
    // Images uploaded during a cancelled edit were never saved: delete them.
    if (editing === "assets" && draft) {
      const saved = new Set(values.assets.assets.map((asset) => asset.path));
      for (const asset of (draft as BrandSectionValues["assets"]).assets) {
        if (saved.has(asset.path)) continue;
        void fetch("/api/brand/assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: asset.path }) }).catch(() => null);
      }
    }
    setEditing(null);
    setDraft(null);
    setError("");
  }

  /**
   * One-tap Confirm on a fact MARA found (onboarding only, where nothing is
   * saved until Finish): the same change the Facts editor makes, without
   * opening it. The live page keeps Edit → Confirm → Save, one version per save.
   */
  function confirmFactLocal(fact: string) {
    const current = values.facts;
    const next: BrandSectionValues["facts"] = {
      facts: current.facts.includes(fact) ? current.facts : [...current.facts, fact],
      unconfirmed: current.unconfirmed.filter((f) => f !== fact),
    };
    setValues((prev) => ({ ...prev, facts: next }));
    onLocalSave?.("facts", next);
  }
  const oneTapConfirm = persist === "local" && mode === "onboarding" && editing === null ? confirmFactLocal : undefined;

  async function save() {
    if (!editing || !draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    if (persist === "local") {
      // Same validation as the server, no database: the wizard saves it all at the end.
      const checked = validateBrandSection(editing, draft);
      if (!checked.ok) {
        setError(checked.error);
        setBusy(false);
        return;
      }
      setValues((prev) => ({ ...prev, [editing]: checked.values }));
      onLocalSave?.(editing, checked.values);
      setEditing(null);
      setDraft(null);
      setBusy(false);
      return;
    }
    try {
      const result = await saveBrandSection(editing, draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const saved = result.values;
      setValues((prev) => ({ ...prev, [editing]: saved }));
      setVersions((prev) => [{
        version: result.version,
        answers: editing === "brief" ? {} : answersFor(editing, saved),
        brief: editing === "brief" ? (saved as BrandSectionValues["brief"]).brief : prev[0]?.brief ?? "",
        assets: editing === "assets" ? (saved as BrandSectionValues["assets"]).assets : prev[0]?.assets ?? [],
        source: "brand_hub",
        changeSummary: `${brandSectionMeta(editing).title} updated`,
        changedKeys: result.changedKeys,
        createdAt: new Date().toISOString(),
      }, ...prev]);
      setNotice(`${brandSectionMeta(editing).title} saved. MARA uses it from the next generation.`);
      setEditing(null);
      setDraft(null);
    } catch {
      setError("Voom couldn't save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {mode === "hub" ? (
        <div className="mb-4 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-text-2">
          <b className="text-text">Edits apply from the next generation.</b> Posts and plans MARA already wrote are not rewritten.
        </div>
      ) : null}
      {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">{error}</div> : null}
      {notice ? <div role="status" className="mb-3.5 rounded-xl border border-emerald-900/40 bg-emerald-950/30 px-3.5 py-2.5 text-sm text-emerald-300">{notice}</div> : null}

      {sections.map((section) => {
        const isEditing = editing === section.id;
        return (
          <section key={section.id} data-brand-section={section.id}>
          <Card className="mb-3.5 p-4">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-lg font-semibold">{section.title}</h2>
                <p className="text-[12.5px] text-text-3">{section.intro}</p>
              </div>
              {isEditing ? (
                <div className="flex gap-2">
                  <Btn variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Btn>
                  <Btn variant="ghost" size="sm" disabled={busy} onClick={cancelEdit}>Cancel</Btn>
                </div>
              ) : (
                <Btn variant="outline" size="sm" disabled={busy || editing !== null} onClick={() => startEdit(section.id)}>
                  <Icon name="edit" size={13} /> Edit
                </Btn>
              )}
            </div>
            {isEditing && draft ? (
              section.id === "assets" ? (
                <AssetsSectionEditor
                  draft={draft as BrandSectionValues["assets"]}
                  updateDraft={setDraft}
                  savedPaths={new Set(values.assets.assets.map((asset) => asset.path))}
                  previews={previews}
                  setPreviews={setPreviews}
                  visionEnabled={visionEnabled}
                  disabled={busy}
                />
              ) : (
                <SectionEditor id={section.id} draft={draft} onChange={setDraft} disabled={busy} values={values} />
              )
            ) : (
              <SectionView id={section.id} values={values} plan={plan} automation={automation} mode={mode} onConfirmFact={oneTapConfirm} previews={previews} />
            )}
          </Card>
          </section>
        );
      })}

      {mode === "onboarding" ? (
        onDone ? (
          <div className="mt-2 flex justify-end">
            <Btn variant="primary" disabled={busy || editing !== null} onClick={onDone}>Looks right</Btn>
          </div>
        ) : null
      ) : (
        <Card className="mb-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">History</h2>
          <p className="mb-3 text-[12.5px] text-text-3">Every save keeps the version before it. Open one to see what changed.</p>
          {versions.length === 0 ? (
            <p className="text-[13.5px] text-text-3">No versions yet. Your first edit here, or your next Settings save, creates version 1.</p>
          ) : (
            <ul className="divide-y divide-line">
              {versions.map((entry, index) => {
                const previous = versions[index + 1] ?? null;
                const open = openVersion === entry.version;
                const changed = entry.changedKeys.length ? entry.changedKeys.map(answerKeyLabel).join(", ") : "No field changed";
                return (
                  <li key={entry.version} className="py-2.5">
                    <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpenVersion(open ? null : entry.version)} aria-expanded={open}>
                      <Tag tone="t-grey">v{entry.version}</Tag>
                      <span className="text-[13.5px] font-semibold">{changed}</span>
                      <span className="text-[12.5px] text-text-3">{formatDate(entry.createdAt)} · {SOURCE_LABELS[entry.source] ?? entry.source}</span>
                      <Icon name={open ? "up" : "down"} size={12} className="ml-auto" />
                    </button>
                    {open ? (
                      <div className="mt-2 space-y-2 rounded-xl bg-surface-2 p-3 text-[12.5px]">
                        {entry.changedKeys.length === 0 ? <p className="text-text-3">{entry.changeSummary || "Saved without changes."}</p> : null}
                        {entry.changedKeys.map((key) => (
                          <div key={key}>
                            <div className="font-semibold text-text-2">{answerKeyLabel(key)}</div>
                            <div className="text-text-3">Before: <span className="text-text">{key === "assets" ? describeBrandAssets(previous?.assets) : describeValue(key === "brief" ? previous?.brief : previous?.answers[key])}</span></div>
                            <div className="text-text-3">After: <span className="text-text">{key === "assets" ? describeBrandAssets(entry.assets) : describeValue(key === "brief" ? entry.brief : entry.answers[key])}</span></div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "nothing";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "nothing";
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${answerKeyLabel(k)}: ${describeValue(v)}`);
    return parts.length ? parts.join(" · ") : "nothing";
  }
  return String(value);
}

/** The kit answers a section's saved values become (mirrors validateBrandSection, for the optimistic history line). */
function answersFor(id: BrandSectionId, saved: BrandSectionValues[BrandSectionId]): Record<string, unknown> {
  switch (id) {
    case "basics": return { ...(saved as BrandSectionValues["basics"]) };
    case "offerings": return { offerings: (saved as BrandSectionValues["offerings"]).offerings };
    case "audience": return { ...(saved as BrandSectionValues["audience"]) };
    case "voice": {
      const v = saved as BrandSectionValues["voice"];
      return { personality: v.personality, voice_samples: { liked: v.liked, disliked: v.disliked } };
    }
    case "avoid": {
      const v = saved as BrandSectionValues["avoid"];
      return { avoid: { rules: v.rules, words: v.words }, notes: v.notes };
    }
    case "facts": {
      const v = saved as BrandSectionValues["facts"];
      return { facts_confirmed: v.facts, facts_unconfirmed: v.unconfirmed };
    }
    case "operate": return { ...(saved as BrandSectionValues["operate"]) };
    case "assets": return { colours: (saved as BrandSectionValues["assets"]).colours };
    default: return {};
  }
}

/** The images section in edit mode: every change goes through functional updates, so out-of-order uploads never clash. */
function AssetsSectionEditor({ draft, updateDraft, savedPaths, previews, setPreviews, visionEnabled, disabled }: {
  draft: BrandSectionValues["assets"];
  updateDraft: Dispatch<SetStateAction<BrandSectionValues[BrandSectionId] | null>>;
  savedPaths: ReadonlySet<string>;
  previews: Record<string, string>;
  setPreviews: Dispatch<SetStateAction<Record<string, string>>>;
  visionEnabled: boolean;
  disabled: boolean;
}) {
  const update = (fn: (prev: BrandSectionValues["assets"]) => BrandSectionValues["assets"]) =>
    updateDraft((prev) => (prev ? fn(prev as BrandSectionValues["assets"]) : prev));
  return (
    <BrandAssetsEditor
      assets={draft.assets}
      colours={draft.colours}
      previews={previews}
      visionEnabled={visionEnabled}
      disabled={disabled}
      savedPaths={savedPaths}
      onAdd={(asset: BrandAsset, previewUrl, computed) => {
        if (previewUrl) setPreviews((prev) => ({ ...prev, [asset.path]: previewUrl }));
        update((prev) => ({ assets: withAddedAsset(prev.assets, asset), colours: asset.kind === "logo" ? coloursAfterLogo(prev.colours, computed) : prev.colours }));
      }}
      onText={(path, text, by) => update((prev) => ({ ...prev, assets: withAssetText(prev.assets, path, text, by) }))}
      onRemove={(path) => update((prev) => ({ ...prev, assets: withoutAsset(prev.assets, path) }))}
      onColours={(colours) => update((prev) => ({ ...prev, colours }))}
    />
  );
}

function AssetThumb({ url, label }: { url?: string; label: string }) {
  return url
    ? <div role="img" aria-label={label} className="h-16 w-16 flex-none rounded-xl border border-line bg-surface-2 bg-cover bg-center" style={{ backgroundImage: `url("${url}")` }} />
    : <div aria-label={label} className="grid h-16 w-16 flex-none place-items-center rounded-xl border border-line bg-surface-2 text-text-3"><Icon name="img" size={16} /></div>;
}

function SectionView({ id, values, plan, automation, mode, onConfirmFact, previews }: { id: BrandSectionId; values: BrandSectionValues; plan: PlanId; automation: AutomationModeValue; mode: "hub" | "onboarding"; onConfirmFact?: (fact: string) => void; previews?: Record<string, string> }) {
  switch (id) {
    case "assets": {
      const { assets, colours } = values.assets;
      if (!assets.length && !colours) {
        return <p className="text-[13.5px] text-text-3">No images yet. Add your logo, product photos and posts you&apos;re proud of; MARA keeps your look from them.</p>;
      }
      const groups: { kind: BrandAsset["kind"]; title: string }[] = [
        { kind: "logo", title: "Logo" },
        { kind: "product", title: "Products" },
        { kind: "past_post", title: "Past posts" },
      ];
      return (
        <div className="space-y-3">
          {colours ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px]" data-brand-colours>
              <span className="font-semibold text-text-2">Brand colours</span>
              {[colours.primary, colours.secondary].filter(Boolean).map((colour) => (
                <span key={colour} className="flex items-center gap-1.5"><span className="h-4 w-4 rounded-full border border-line" style={{ background: colour ?? undefined }} /><span className="font-mono text-text-3">{colour}</span></span>
              ))}
              <Tag tone={colours.source === "logo" ? "t-brand" : "t-grey"}>{colours.source === "logo" ? "Computed from your logo" : "Picked by you"}</Tag>
            </div>
          ) : null}
          {groups.map(({ kind, title }) => {
            const items = assets.filter((asset) => asset.kind === kind);
            if (!items.length) return null;
            return (
              <div key={kind}>
                <div className="mb-1.5 text-[12px] font-semibold text-text-2">{title}</div>
                <ul className="space-y-2">
                  {items.map((asset) => (
                    <li key={asset.path} className="flex gap-3" data-asset={asset.kind}>
                      <AssetThumb url={previews?.[asset.path]} label={asset.description || title} />
                      <div className="min-w-0 text-[13.5px]">
                        <p>{asset.description || <span className="text-text-3">No description yet.</span>}{asset.describedBy === "mara" ? <Tag tone="t-brand" className="ml-1.5">MARA&apos;s guess</Tag> : null}</p>
                        {asset.chips.length ? <div className="mt-1 flex flex-wrap gap-1">{asset.chips.map((chip) => <Tag key={chip} tone="t-grey">{chip}</Tag>)}</div> : null}
                        {asset.look ? <p className="mt-1 text-[12.5px] text-text-3">{asset.look}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      );
    }
    case "basics":
      return (
        <div className="space-y-2">
          <p className="text-[14px]"><b>{values.basics.name || "No name yet"}</b>{values.basics.category ? <span className="text-text-3"> · {values.basics.category}</span> : null}</p>
          <Para empty="No description yet. MARA writes generic copy until you add one.">{values.basics.description}</Para>
        </div>
      );
    case "brief":
      return <Para empty="No brief yet. Until you write one, MARA works from your description.">{values.brief.brief}</Para>;
    case "offerings":
      return <ChipList items={values.offerings.offerings} empty="Nothing listed yet. MARA infers what you sell from your description." />;
    case "audience":
      return (
        <div className="space-y-2">
          <ChipList items={values.audience.audience} empty="No audience chosen. Captions stay broad." />
          <p className="text-[13.5px] text-text-2">Main goal: <b className="text-text">{values.audience.goal || "not set"}</b></p>
        </div>
      );
    case "voice":
      return (
        <div className="space-y-3">
          <ChipList items={values.voice.personality} empty="No personality chosen. MARA uses a neutral tone." />
          <div>
            <div className="mb-1 text-[12px] font-semibold text-text-2">Sounds like us</div>
            {values.voice.liked.length ? values.voice.liked.map((s) => <p key={s} className="mb-1 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">{s}</p>) : <p className="text-[13px] text-text-3">No samples yet.</p>}
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-text-2">Not us</div>
            {values.voice.disliked.length ? values.voice.disliked.map((s) => <p key={s} className="mb-1 rounded-lg bg-surface-2 px-3 py-2 text-[13px] line-through decoration-text-3">{s}</p>) : <p className="text-[13px] text-text-3">No samples yet.</p>}
          </div>
        </div>
      );
    case "avoid":
      return (
        <div className="space-y-2">
          <ChipList items={values.avoid.rules} empty="No rules yet." />
          <p className="text-[13.5px] text-text-2">Banned words: <b className="text-text">{values.avoid.words.length ? values.avoid.words.join(", ") : "none"}</b></p>
          <Para empty="Nothing specific noted.">{values.avoid.notes}</Para>
        </div>
      );
    case "facts":
      return (
        <div className="space-y-3">
          {values.facts.facts.length
            ? <ul className="list-disc space-y-1 pl-5 text-[14px]">{values.facts.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
            : <p className="text-[13.5px] text-text-3">No confirmed facts. MARA states no years, awards or numbers until you add some.</p>}
          {values.facts.unconfirmed.length ? (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-text-2">Needs confirmation <Tag tone="t-amber">{values.facts.unconfirmed.length}</Tag></div>
              <p className="mb-1.5 text-[12.5px] text-text-3">
                MARA found these in your description. She never states them until you confirm them{onConfirmFact ? "; Edit removes one for good." : " with Edit."}
              </p>
              <ul className="space-y-1">
                {values.facts.unconfirmed.map((fact) => (
                  <li key={fact} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-text-2">
                    <span>{fact}</span>
                    {onConfirmFact ? <Btn variant="outline" size="sm" onClick={() => onConfirmFact(fact)}>Confirm</Btn> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    case "operate":
      return (
        <div className="space-y-3">
          <p className="text-[13.5px] text-text-2">Posting pace: <b className="text-text">{values.operate.pace || "not set (MARA assumes 2–3 times a week)"}</b></p>
          <p className="text-[13.5px] text-text-2">Channels: <b className="text-text">{values.operate.channels.length ? values.operate.channels.join(", ") : "none selected"}</b></p>
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-text-2">Automation level · {AUTOMATION_MODE_LABELS[automation]}</div>
            {mode === "hub" ? <AutomationMode initial={automation} plan={plan} compact showPlanSummary={false} /> : null}
          </div>
        </div>
      );
    default:
      return null;
  }
}

/**
 * "Write 3 new samples" (slice 6) inside the How we sound editor: MARA writes
 * from the saved sections plus this draft; a tap adds the caption to the
 * draft's list, and the section's Save records it like any typed sample.
 */
function VoiceSamplesWriter({ values, draft, disabled, onChange }: { values: BrandSectionValues; draft: BrandSectionValues["voice"]; disabled: boolean; onChange: (next: BrandSectionValues["voice"]) => void }) {
  const [samples, setSamples] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");

  async function write() {
    if (writing) return;
    setWriting(true);
    setMessage("");
    const result = await requestVoiceSamples(voiceSnapshotFromSections({ ...values, voice: draft }));
    setWriting(false);
    if (result.ok) {
      setSamples(result.samples);
    } else {
      setSamples([]);
      setMessage(voiceSamplesMessage(result.reason));
    }
  }

  function sort(sample: string, verdict: SampleVerdict) {
    const next = sortSample({ liked: draft.liked, disliked: draft.disliked }, sample, verdict);
    if (!next) {
      setMessage(`Up to ${VOICE_SAMPLES_PER_LIST} per list. Remove one below first.`);
      return;
    }
    setMessage("");
    onChange({ ...draft, ...next });
  }

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[12.5px] font-semibold text-text-2">Samples from MARA</div>
          <p className="text-[12px] text-text-3">She writes three from your Brand page; tap the ones that sound like you. Save keeps your picks.</p>
        </div>
        <Btn variant="outline" size="sm" disabled={disabled || writing} onClick={() => void write()}>{writing ? "Writing…" : samples.length ? "Try 3 more" : "Write 3 new samples"}</Btn>
      </div>
      {writing ? <div className="mt-3"><WritingSamplesPanel /></div> : null}
      {!writing && samples.length ? <div className="mt-3"><VoiceSampleCards samples={samples} liked={draft.liked} disliked={draft.disliked} disabled={disabled} onSort={sort} /></div> : null}
      {message ? <p role="status" className="mt-2 text-[12.5px] text-text-2">{message}</p> : null}
    </div>
  );
}

function SectionEditor({ id, draft, onChange, disabled, values }: { id: BrandSectionId; draft: BrandSectionValues[BrandSectionId]; onChange: (next: BrandSectionValues[BrandSectionId]) => void; disabled: boolean; values?: BrandSectionValues }) {
  switch (id) {
    case "basics": {
      const d = draft as BrandSectionValues["basics"];
      return (
        <div>
          <Field label="Business name"><Input value={d.name} disabled={disabled} onChange={(e) => onChange({ ...d, name: e.target.value })} /></Field>
          <Field label="Describe your brand" hint="What you do, who you serve and what makes you different."><Textarea rows={4} value={d.description} disabled={disabled} onChange={(e) => onChange({ ...d, description: e.target.value })} /></Field>
          <Field label="Kind of business">
            <select className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]" value={d.category} disabled={disabled} onChange={(e) => onChange({ ...d, category: e.target.value })}>
              <option value="">Not set</option>
              {Q_INDUSTRY.map(([, name]) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
        </div>
      );
    }
    case "brief": {
      const d = draft as BrandSectionValues["brief"];
      return <Field label="Brand Brief" hint="A few short paragraphs: what you are, what you offer, who it's for, how you sound. Clear it to go back to your description."><Textarea rows={8} value={d.brief} disabled={disabled} onChange={(e) => onChange({ brief: e.target.value })} /></Field>;
    }
    case "offerings": {
      const d = draft as BrandSectionValues["offerings"];
      return <Field label="What we offer" hint="One per line, up to 20."><ListText items={d.offerings} separator="line" rows={5} disabled={disabled} onChange={(offerings) => onChange({ offerings })} /></Field>;
    }
    case "audience": {
      const d = draft as BrandSectionValues["audience"];
      return (
        <div className="space-y-3">
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Audience</div><Toggle options={Q_CUSTOMER} selected={d.audience} disabled={disabled} onChange={(audience) => onChange({ ...d, audience })} /></div>
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Main goal</div><Pick options={Q_GOAL.map(([, name]) => name)} value={d.goal} disabled={disabled} onChange={(goal) => onChange({ ...d, goal })} /></div>
        </div>
      );
    }
    case "voice": {
      const d = draft as BrandSectionValues["voice"];
      return (
        <div className="space-y-3">
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Personality</div><Toggle options={OB_TONE} selected={d.personality} disabled={disabled} onChange={(personality) => onChange({ ...d, personality })} /></div>
          {values ? <VoiceSamplesWriter values={values} draft={d} disabled={disabled} onChange={onChange} /> : null}
          <Field label="Sounds like us" hint="Captions you'd be happy to post, one per line, up to 5."><ListText items={d.liked} separator="line" rows={3} disabled={disabled} onChange={(liked) => onChange({ ...d, liked })} /></Field>
          <Field label="Not us" hint="Captions you'd never post, one per line, up to 5."><ListText items={d.disliked} separator="line" rows={3} disabled={disabled} onChange={(disliked) => onChange({ ...d, disliked })} /></Field>
        </div>
      );
    }
    case "avoid": {
      const d = draft as BrandSectionValues["avoid"];
      return (
        <div className="space-y-3">
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Rules</div><Toggle options={AVOID_RULES} selected={d.rules} disabled={disabled} onChange={(rules) => onChange({ ...d, rules })} /></div>
          <Field label="Words, topics or emoji to ban" hint="Comma-separated. MARA never uses them, in any casing."><ListText items={d.words} separator="comma" disabled={disabled} onChange={(words) => onChange({ ...d, words })} /></Field>
          <Field label="Anything specific MARA should know or do?"><Textarea rows={3} value={d.notes} disabled={disabled} onChange={(e) => onChange({ ...d, notes: e.target.value })} /></Field>
        </div>
      );
    }
    case "facts": {
      const d = draft as BrandSectionValues["facts"];
      return (
        <div>
          <Field label="Facts MARA may state" hint="One per line. Only what you can stand behind: 'Roasting since 2014', 'Family-run'."><ListText items={d.facts} separator="line" rows={4} disabled={disabled} onChange={(facts) => onChange({ ...d, facts })} /></Field>
          {d.unconfirmed.length ? (
            <div>
              <div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Needs confirmation</div>
              <ul className="space-y-1.5">
                {d.unconfirmed.map((fact) => (
                  <li key={fact} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                    <span>{fact}</span>
                    <span className="flex gap-1.5">
                      <Btn variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ facts: d.facts.includes(fact) ? d.facts : [...d.facts, fact], unconfirmed: d.unconfirmed.filter((f) => f !== fact) })}>Confirm</Btn>
                      <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...d, unconfirmed: d.unconfirmed.filter((f) => f !== fact) })}>Remove</Btn>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    }
    case "operate": {
      const d = draft as BrandSectionValues["operate"];
      return (
        <div className="space-y-3">
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Posting pace</div><Pick options={Q_FREQ} value={d.pace} disabled={disabled} onChange={(pace) => onChange({ ...d, pace })} /></div>
          <div><div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Channels</div><Toggle options={Q_CHANNELS} selected={d.channels} disabled={disabled} onChange={(channels) => onChange({ ...d, channels })} /></div>
          <p className="text-[12px] text-text-3">The automation level is changed with the cards below; it saves on its own.</p>
        </div>
      );
    }
    default:
      return null;
  }
}
