"use client";

/**
 * Brand Kit v2, slice 5: logo, product photos and past posts.
 *
 * One editor for the onboarding screen "Give MARA your brand" and the Brand
 * page's images section. Each file uploads at once to the private bucket
 * (POST /api/brand/assets); when image reading is configured MARA then looks
 * at it (POST /api/brand/assets/describe) and fills the line, marked "MARA's
 * guess" until the owner changes it. Without image reading, or when it fails,
 * the line simply stays empty for the owner to type.
 *
 * The parent owns the list and applies every change through the four
 * callbacks, so uploads that finish out of order can never overwrite each
 * other. Nothing here saves a kit version: onboarding saves at Finish, the
 * Brand page on Save.
 */
import { useRef, useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, Chip, Input, Tag } from "@/components/voom/ui/primitives";
import {
  BRAND_ASSET_ACCEPT, BRAND_ASSET_LIMITS, BRAND_COLOUR_SOURCE_LABELS, PAST_POST_CHIPS, brandAssetCount,
  clearBrandColours, pickBrandColour, swapBrandColours, chooseFoundPalette,
  type BrandAsset, type BrandAssetKind, type BrandAssetText, type BrandColours,
} from "@/lib/brand/assets";

export const PAST_POST_DISCLAIMER = "MARA uses these to keep your current look and voice. Only share work you'd be happy to see more of. Anything you upload here shapes the images and captions she creates, so leave out posts that don't represent your brand.";
export const VISION_PRIVACY_NOTE = "To describe each image, MARA sends a small copy of it to Voom's AI provider. Nothing is posted anywhere.";

export interface BrandAssetsEditorProps {
  assets: BrandAsset[];
  colours: BrandColours | null;
  previews: Record<string, string>;
  visionEnabled: boolean;
  disabled?: boolean;
  /** Paths already saved in the kit: removing one only drops it from the list (the Brand page deletes it on Save). */
  savedPaths?: ReadonlySet<string>;
  onAdd: (asset: BrandAsset, previewUrl: string | null, computed: { primary: string | null; secondary: string | null } | null) => void;
  onText: (path: string, text: BrandAssetText, by: "mara" | "owner") => void;
  onRemove: (path: string) => void;
  onColours: (colours: BrandColours | null) => void;
}

type UploadResponse = { asset?: BrandAsset; previewUrl?: string | null; colours?: { primary: string | null; secondary: string | null } | null; error?: string };
type DescribeResponse = { ok: boolean; reading?: { description: string; chips: string[]; look: string } };

const KIND_LABELS: Record<BrandAssetKind, { title: string; help: string; add: string; line: string; placeholder: string }> = {
  logo: { title: "Logo", help: "One image. MARA takes your two brand colours from it.", add: "Upload your logo", line: "What the logo shows", placeholder: "e.g. Brown coffee bean above the words Bean & Co." },
  product: { title: "Product or service photos", help: `Up to ${BRAND_ASSET_LIMITS.product}. One line each saying what it is.`, add: "Add product photos", line: "What is this?", placeholder: "e.g. Iced latte in a tall glass" },
  past_post: { title: "Past posts you're proud of", help: `Up to ${BRAND_ASSET_LIMITS.past_post} images from anywhere you've posted before Voom.`, add: "Add past posts", line: "What it shows", placeholder: "e.g. Morning pour-over on the counter" },
};

function Thumb({ url, label }: { url?: string; label: string }) {
  return url
    ? <div role="img" aria-label={label} className="h-20 w-20 flex-none rounded-xl border border-line bg-surface-2 bg-cover bg-center" style={{ backgroundImage: `url("${url}")` }} />
    : <div aria-label={label} className="grid h-20 w-20 flex-none place-items-center rounded-xl border border-line bg-surface-2 text-text-3"><Icon name="img" size={18} /></div>;
}

export function BrandAssetsEditor({ assets, colours, previews, visionEnabled, disabled, savedPaths, onAdd, onText, onRemove, onColours }: BrandAssetsEditorProps) {
  const [busyKind, setBusyKind] = useState<BrandAssetKind | null>(null);
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const inputs = useRef<Partial<Record<BrandAssetKind, HTMLInputElement | null>>>({});

  async function describe(asset: BrandAsset) {
    if (!visionEnabled) return;
    setReading((prev) => new Set(prev).add(asset.path));
    try {
      const response = await fetch("/api/brand/assets/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: asset.path, kind: asset.kind }),
      });
      const body = (await response.json().catch(() => ({ ok: false }))) as DescribeResponse;
      if (body.ok && body.reading) onText(asset.path, body.reading, "mara");
    } catch {
      /* The line stays empty for the owner to type. */
    } finally {
      setReading((prev) => {
        const next = new Set(prev);
        next.delete(asset.path);
        return next;
      });
    }
  }

  async function upload(kind: BrandAssetKind, files: FileList | null) {
    if (!files?.length) return;
    setError("");
    setBusyKind(kind);
    const room = BRAND_ASSET_LIMITS[kind] - brandAssetCount(assets, kind);
    const chosen = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > chosen.length) setError(`Only ${BRAND_ASSET_LIMITS[kind]} ${KIND_LABELS[kind].title.toLowerCase()} fit. The extra files were left out.`);
    for (const file of chosen) {
      if (file.size > BRAND_ASSET_LIMITS.maxBytes) {
        setError(`${file.name} is over 10 MB. Choose a smaller image.`);
        continue;
      }
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      try {
        const response = await fetch("/api/brand/assets", { method: "POST", body: form });
        const body = (await response.json().catch(() => ({}))) as UploadResponse;
        if (!response.ok || !body.asset) {
          setError(body.error ?? "Voom couldn't store that image. Nothing changed.");
          continue;
        }
        onAdd(body.asset, body.previewUrl ?? null, body.colours ?? null);
        void describe(body.asset);
      } catch {
        setError("Voom couldn't reach the server. Check your connection and try again.");
      }
    }
    setBusyKind(null);
    const input = inputs.current[kind];
    if (input) input.value = "";
  }

  function remove(asset: BrandAsset) {
    // Unsaved uploads are deleted at once; saved ones go when the Brand page is saved.
    if (!savedPaths?.has(asset.path)) {
      void fetch("/api/brand/assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: asset.path }),
      }).catch(() => null);
    }
    onRemove(asset.path);
  }

  function row(kind: BrandAssetKind) {
    const labels = KIND_LABELS[kind];
    const items = assets.filter((asset) => asset.kind === kind);
    const full = items.length >= BRAND_ASSET_LIMITS[kind];
    return (
      <div className="mb-5" data-asset-kind={kind}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <b className="text-[13.5px]">{labels.title}</b>
          {full ? null : (
            <>
              <input
                ref={(node) => { inputs.current[kind] = node; }}
                type="file"
                accept={BRAND_ASSET_ACCEPT}
                multiple={kind !== "logo"}
                className="hidden"
                onChange={(e) => void upload(kind, e.target.files)}
              />
              <Btn variant="outline" size="sm" disabled={disabled || busyKind !== null} onClick={() => inputs.current[kind]?.click()}>
                <Icon name="plus" size={13} /> {busyKind === kind ? "Uploading…" : labels.add}
              </Btn>
            </>
          )}
        </div>
        <p className="mb-2.5 text-[12.5px] text-text-3">{labels.help}</p>
        {kind === "past_post" ? <p className="mb-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-text-2">{PAST_POST_DISCLAIMER}</p> : null}
        <div className="space-y-2.5">
          {items.map((asset) => (
            <div key={asset.path} className="flex gap-3 rounded-[14px] border border-line p-3" data-asset={asset.kind}>
              <Thumb url={previews[asset.path]} label={asset.description || labels.title} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-text-2">{labels.line}</span>
                  <span className="flex items-center gap-1.5">
                    {reading.has(asset.path) ? <Tag tone="t-grey">MARA is looking…</Tag> : asset.describedBy === "mara" ? <Tag tone="t-brand">MARA&apos;s guess</Tag> : null}
                    <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => remove(asset)} aria-label={`Remove ${labels.title.toLowerCase()}`}>
                      <Icon name="trash" size={13} /> Remove
                    </Btn>
                  </span>
                </div>
                <Input
                  value={asset.description}
                  maxLength={BRAND_ASSET_LIMITS.description}
                  placeholder={labels.placeholder}
                  disabled={disabled}
                  onChange={(e) => onText(asset.path, { description: e.target.value }, "owner")}
                />
                {kind === "past_post" ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {PAST_POST_CHIPS.map((chip) => {
                        const active = asset.chips.includes(chip);
                        return (
                          <Chip
                            key={chip}
                            active={active}
                            disabled={disabled || (!active && asset.chips.length >= BRAND_ASSET_LIMITS.chips)}
                            onClick={() => onText(asset.path, { chips: active ? asset.chips.filter((c) => c !== chip) : [...asset.chips, chip] }, "owner")}
                          >
                            {chip}
                          </Chip>
                        );
                      })}
                    </div>
                    <Input
                      value={asset.look}
                      maxLength={BRAND_ASSET_LIMITS.look}
                      placeholder="The look, e.g. warm morning light, close-up, cream and brown tones"
                      disabled={disabled}
                      onChange={(e) => onText(asset.path, { look: e.target.value }, "owner")}
                    />
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {kind === "logo" ? <ColourPicker colours={colours} disabled={disabled} onColours={onColours} /> : null}
      </div>
    );
  }

  return (
    <div>
      {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">{error}</div> : null}
      {row("logo")}
      {row("product")}
      {row("past_post")}
      <p className="text-[12px] text-text-3">
        JPEG, PNG or WebP, up to 10 MB each. Stored privately in Voom.{visionEnabled ? ` ${VISION_PRIVACY_NOTE}` : " Type a line for each image so MARA knows what it is."}
      </p>
    </div>
  );
}

/**
 * The colours MARA uses (slice 7): every palette found (from the logo's
 * pixels, from the website's look) is shown side by side with "Use these";
 * the row in use names which one it is; Main is the dominant colour, Swap
 * flips the two, and typing a colour makes the pair the owner's own pick.
 */
function ColourPicker({ colours, disabled, onColours }: { colours: BrandColours | null; disabled?: boolean; onColours: (colours: BrandColours | null) => void }) {
  const inUse = Boolean(colours && (colours.primary || colours.secondary));
  const found = (["logo", "website"] as const).filter((which) => colours?.found?.[which]);
  return (
    <div className="mt-3 rounded-[14px] border border-line p-3" data-brand-colours>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-text-2">Colours MARA uses</span>
        {inUse && colours ? <Tag tone={colours.source === "owner" ? "t-grey" : "t-brand"}>{BRAND_COLOUR_SOURCE_LABELS[colours.source]}</Tag> : null}
      </div>
      {found.length ? (
        <ul className="mb-3 space-y-1.5" data-brand-palettes>
          {found.map((which) => {
            const palette = colours!.found![which]!;
            const active = inUse && colours!.source === which && colours!.primary === palette.primary && colours!.secondary === palette.secondary;
            return (
              <li key={which} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                {[palette.primary, palette.secondary].filter(Boolean).map((hex) => <span key={hex} className="inline-block h-5 w-5 rounded-md border border-line" style={{ backgroundColor: hex! }} title={hex!} />)}
                <span className="text-text-2">{BRAND_COLOUR_SOURCE_LABELS[which]}</span>
                {active ? <Tag tone="t-green">In use</Tag> : <Btn variant="outline" size="sm" disabled={disabled} onClick={() => onColours(chooseFoundPalette(colours, which))}>Use these</Btn>}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        {(["primary", "secondary"] as const).map((which) => (
          <label key={which} className="flex items-center gap-2 text-[13px]">
            <input
              type="color"
              className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-surface-2"
              value={colours?.[which] ?? "#FFFFFF"}
              disabled={disabled}
              onChange={(e) => onColours(pickBrandColour(colours, which, e.target.value))}
            />
            <span>{which === "primary" ? "Main" : "Second"} <span className="font-mono text-text-3">{colours?.[which] ?? "not set"}</span></span>
          </label>
        ))}
        {inUse && colours?.primary && colours.secondary ? <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => onColours(swapBrandColours(colours))}>Swap</Btn> : null}
        {inUse ? <Btn variant="ghost" size="sm" disabled={disabled} onClick={() => onColours(clearBrandColours(colours))}>Clear colours</Btn> : null}
      </div>
      <p className="mt-2 text-[11.5px] text-text-3">Main is the colour MARA leads with in images; Second supports it.</p>
    </div>
  );
}
