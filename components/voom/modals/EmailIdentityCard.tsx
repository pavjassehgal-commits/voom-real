"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Card, Field, Input } from "@/components/voom/ui/primitives";

/**
 * Settings → Email identity & branding.
 *
 * Shows the TRUTHFUL sender state (what the next email actually comes from,
 * and the provider-backed verification status of the requested domain) and
 * lets the owner edit the sender identity, brand profile and published
 * email images. Nothing here can claim a domain is verified — only the
 * provider can.
 */

interface IdentityState {
  businessName: string | null;
  sender: {
    fromName: string;
    fromAddress: string;
    replyTo: string | null;
    mode: "business_verified" | "voom_fallback";
  } | null;
  identity: {
    displayName: string | null;
    fromAddress: string | null;
    replyTo: string | null;
  } | null;
  verification: {
    status: "not_configured" | "pending" | "verified" | "failed" | "unknown";
    domain: string | null;
    providerConfigured: boolean;
  };
  brand: {
    logoAssetId: string | null;
    primaryColor: string | null;
    secondaryColor: string | null;
    website: string | null;
    footerLine: string | null;
  };
  assets: Array<{
    id: string;
    url: string;
    altText: string;
    mimeType: string;
    width: number | null;
    height: number | null;
  }>;
}

const VERIFICATION_UI: Record<IdentityState["verification"]["status"], { label: string; tone: "green" | "amber" | "red" | "grey"; note: string | null }> = {
  verified: {
    label: "Verified",
    tone: "green",
    note: "Emails are sent from your domain address.",
  },
  pending: {
    label: "Waiting for domain setup",
    tone: "amber",
    note: "Follow the setup steps your email provider showed you for this domain. Voom re-checks every time you open this page or send an email.",
  },
  failed: {
    label: "Domain check failed",
    tone: "red",
    note: "The domain check didn't pass. Until it does, emails send from Voom's managed address with your business name shown.",
  },
  unknown: {
    label: "Not verified",
    tone: "grey",
    note: "Until the domain is verified, emails send from Voom's managed address with your business name shown.",
  },
  not_configured: {
    label: "Not configured",
    tone: "grey",
    note: "No sending identity is configured yet.",
  },
};

const TONE_CLASS: Record<"green" | "amber" | "red" | "grey", string> = {
  green: "bg-green/15 text-green",
  amber: "bg-amber/15 text-amber",
  red: "bg-red/15 text-red",
  grey: "bg-surface-2 text-text-2",
};

const EMAIL_TYPES: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

export function EmailIdentityCard() {
  const [state, setState] = useState<IdentityState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#1A73E8");
  const [secondaryColor, setSecondaryColor] = useState("#F4F1EC");
  const [website, setWebsite] = useState("");
  const [footerLine, setFooterLine] = useState("");
  const [logoAssetId, setLogoAssetId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Fetches the identity picture; returns it without touching React state. */
  const fetchIdentity = useCallback(async (): Promise<IdentityState | { error: string }> => {
    try {
      const response = await fetch("/api/voom/email-identity", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (IdentityState & { error?: string }) | null;
      if (!response.ok || !body || body.error) {
        return { error: body?.error ?? "Voom couldn’t load your email identity." };
      }
      return body;
    } catch {
      return { error: "Voom couldn’t load your email identity. Please retry." };
    }
  }, []);

  const applyIdentity = useCallback((data: IdentityState) => {
    setState(data);
    setDisplayName(data.identity?.displayName ?? "");
    setFromAddress(data.identity?.fromAddress ?? "");
    setReplyTo(data.identity?.replyTo ?? "");
    setPrimaryColor(data.brand.primaryColor ?? "#1A73E8");
    setSecondaryColor(data.brand.secondaryColor ?? "#F4F1EC");
    setWebsite(data.brand.website ?? "");
    setFooterLine(data.brand.footerLine ?? "");
    setLogoAssetId(data.brand.logoAssetId ?? null);
  }, []);

  const reload = useCallback(async () => {
    const data = await fetchIdentity();
    if ("error" in data) {
      setLoadError(data.error);
      return;
    }
    setLoadError(null);
    applyIdentity(data);
  }, [fetchIdentity, applyIdentity]);

  useEffect(() => {
    let cancelled = false;
    void fetchIdentity().then((data) => {
      if (cancelled) return;
      if ("error" in data) setLoadError(data.error);
      else applyIdentity(data);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchIdentity, applyIdentity]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/voom/email-identity", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity: { displayName, fromAddress: fromAddress || null, replyTo: replyTo || null },
          brand: {
            logoAssetId,
            primaryColor: primaryColor || null,
            secondaryColor: secondaryColor || null,
            website: website || null,
            footerLine: footerLine || null,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as (Partial<IdentityState> & { error?: string }) | null;
      if (!response.ok) {
        setMessage({ kind: "err", text: body?.error ?? "Voom couldn’t save those changes." });
        return;
      }
      await reload();
      setMessage({ kind: "ok", text: "Email identity saved. The next email uses these settings." });
    } catch {
      setMessage({ kind: "err", text: "Voom couldn’t save those changes. Please retry." });
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setMessage(null);
    try {
      const mimeType = EMAIL_TYPES[file.type];
      if (!mimeType) {
        setMessage({ kind: "err", text: "Use a JPEG, PNG or WebP image." });
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setMessage({ kind: "err", text: "That image is over 10 MB." });
        return;
      }
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("read_failed"));
        reader.readAsDataURL(file);
      });

      const response = await fetch("/api/voom/email-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "upload", bytesBase64: base64, mimeType, altText: file.name.replace(/\.[a-z0-9]+$/i, "") }),
      });
      const body = (await response.json().catch(() => null)) as { asset?: { id: string; url: string; altText: string }; error?: string } | null;
      if (!response.ok) {
        setMessage({ kind: "err", text: body?.error ?? "Voom couldn’t publish that image." });
        return;
      }
      await reload();
      setMessage({ kind: "ok", text: "Image published. Pick it as the logo (or hero) below." });
    } catch {
      setMessage({ kind: "err", text: "Voom couldn’t publish that image. Please retry." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRemoveAsset(assetId: string) {
    try {
      await fetch(`/api/voom/email-assets/${assetId}`, { method: "DELETE" });
      if (logoAssetId === assetId) setLogoAssetId(null);
      await reload();
    } catch {
      setMessage({ kind: "err", text: "Voom couldn’t remove that image. Please retry." });
    }
  }

  const verification = VERIFICATION_UI[state?.verification.status ?? "not_configured"];
  const sendingName = state?.sender?.fromName ?? (state?.businessName || "Your business");
  const sendingAddress = state?.sender?.fromAddress;

  return (
    <Card className="mb-3.5 p-4">
      <h2 className="mb-1.5 font-display text-lg font-semibold">Email identity & branding</h2>
      <p className="mb-3.5 text-[12.5px] text-text-3">
        How your marketing email looks and who it comes from. Voom stays out of the customer’s inbox — the email is your business, not Voom.
      </p>

      {loadError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">
          {loadError}
        </div>
      )}

      {/* The truth: what the next email actually comes from. */}
      <div className="mb-4 rounded-xl border border-line bg-surface-2/60 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">
            Next email sends as <b>{sendingName}</b>
            {sendingAddress ? ` <${sendingAddress}>` : ""}
          </span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${TONE_CLASS[verification.tone]}`}>
            {verification.label}
          </span>
        </div>
        {state?.sender?.mode === "voom_fallback" && sendingAddress && (
          <div className="mt-1 text-[12px] text-amber">
            Your domain isn’t verified yet, so delivery uses Voom’s managed address ({sendingAddress}) with your business name shown — never a fake “from you” address.
          </div>
        )}
        {verification.note && <div className="mt-1 text-[12px] leading-relaxed text-text-2">{verification.note}</div>}
        {state?.verification.domain && state.verification.status !== "verified" && (
          <div className="mt-1 text-[12px] text-text-3">Domain being checked: {state.verification.domain}</div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sender name" hint="Shown in the recipient's inbox. Defaults to your business name.">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={state?.businessName ?? "Your business name"} />
        </Field>
        <Field label="Sender email address" hint="Your business address, e.g. hello@yourbusiness.com. Only used once your domain is verified.">
          <Input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="hello@yourbusiness.com" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reply-to" hint="Where customer replies should go. Leave empty to reply to the sender address.">
          <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@yourbusiness.com" />
        </Field>
        <Field label="Website" hint="Used as the default link destination when a CTA has no other destination.">
          <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yourbusiness.com" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Primary color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Primary color"
              value={primaryColor || "#1A73E8"}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-[46px] w-14 cursor-pointer rounded-xl border border-line bg-surface-2"
            />
            <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#1A73E8" />
          </div>
        </Field>
        <Field label="Secondary color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Secondary color"
              value={secondaryColor || "#F4F1EC"}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="h-[46px] w-14 cursor-pointer rounded-xl border border-line bg-surface-2"
            />
            <Input value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} placeholder="#F4F1EC" />
          </div>
        </Field>
      </div>
      <Field label="Footer line" hint="A real, short line under the email — address or contact info you actually use.">
        <Input value={footerLine} onChange={(e) => setFooterLine(e.target.value)} placeholder="12 Main Street · support@yourbusiness.com" />
      </Field>

      {/* Email images */}
      <div className="mt-4 rounded-xl border border-line p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold">Email images</div>
            <div className="text-[12px] text-text-3">
              Your real photos, optimized for email. Voom never auto-generates paid imagery for email.
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <Btn variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Publishing…" : "Add image"}
          </Btn>
        </div>
        {state && state.assets.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {state.assets.map((asset) => (
              <div
                key={asset.id}
                className={`group relative overflow-hidden rounded-lg border-2 ${logoAssetId === asset.id ? "border-brand" : "border-line"}`}
              >
                {/* Owner-scoped, email-safe public URL (migration 0041). */}
                <img src={asset.url} alt={asset.altText || "Email image"} className="aspect-square w-full object-cover" />
                <button
                  type="button"
                  title={logoAssetId === asset.id ? "Logo" : "Use as logo"}
                  onClick={() => setLogoAssetId(logoAssetId === asset.id ? null : asset.id)}
                  className={`absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${logoAssetId === asset.id ? "bg-brand text-white" : "bg-black/50 text-white"}`}
                >
                  {logoAssetId === asset.id ? "Logo" : "Make logo"}
                </button>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => void handleRemoveAsset(asset.id)}
                  className="absolute right-1.5 top-1.5 hidden rounded-full bg-black/50 px-1.5 py-0.5 text-[10.5px] text-white group-hover:block"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-text-3">No published images yet. Emails use a clean, on-brand text layout until you add some.</p>
        )}
      </div>

      {message && (
        <div
          role={message.kind === "err" ? "alert" : "status"}
          className={`mt-3.5 rounded-xl px-3.5 py-2.5 text-sm ${message.kind === "ok" ? "border border-green/40 bg-green/10 text-green" : "border border-red-900/40 bg-red-950/30 text-red-300"}`}
        >
          {message.text}
        </div>
      )}

      <div className="mt-3.5">
        <Btn variant="primary" size="sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save email identity"}
        </Btn>
        <span className="ml-3 text-[12px] text-text-3">
          Verified status is set by your email provider — Voom never claims it on its own.
        </span>
      </div>
    </Card>
  );
}
