"use client";

import { useMemo, useState } from "react";

/**
 * The shared, honest email preview — the exact same deterministic render the
 * production send path produces (fetched from the preview API routes), with
 * desktop/mobile views and the real sender identity the next send will use.
 * There is no second, prettier "preview renderer": what the owner sees here
 * is what the recipient gets.
 */

export interface PreviewQualityFailure {
  code: string;
  message: string;
}

export interface PreviewData {
  sender: {
    fromName: string;
    fromAddress: string;
    replyTo: string | null;
    mode: "business_verified" | "voom_fallback";
  } | null;
  verification: {
    status: "not_configured" | "pending" | "verified" | "failed" | "unknown";
    domain: string | null;
    providerConfigured: boolean;
  };
  subject: string;
  preheader: string;
  html: string;
  text: string;
  layout: string;
  layoutReason: string;
  designSource: "compiled" | "proposed";
  quality: {
    ok: boolean;
    failures: PreviewQualityFailure[];
  };
}

const VERIFICATION_LABEL: Record<PreviewData["verification"]["status"], { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  verified: { label: "Verified — sending from your domain", tone: "green" },
  pending: { label: "Waiting for domain setup", tone: "amber" },
  failed: { label: "Domain check failed", tone: "red" },
  not_configured: { label: "Not configured", tone: "grey" },
  unknown: { label: "Not verified", tone: "grey" },
};

const TONE_CLASS: Record<"green" | "amber" | "red" | "grey", string> = {
  green: "bg-green/15 text-green",
  amber: "bg-amber/15 text-amber",
  red: "bg-red/15 text-red",
  grey: "bg-surface-2 text-text-2",
};

export function EmailPreview({ data, recipientNote }: { data: PreviewData; recipientNote?: string | null }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [showText, setShowText] = useState(false);

  const verification = VERIFICATION_LABEL[data.verification?.status ?? "unknown"];

  const deviceClass = useMemo(
    () => (device === "mobile" ? "w-[360px] max-w-full" : "w-full"),
    [device],
  );

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      {/* Sender identity — the truth about who the next send comes from. */}
      <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-[12.5px] leading-relaxed">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">
            {data.sender ? `${data.sender.fromName} <${data.sender.fromAddress}>` : "Sender not configured"}
          </span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[verification.tone]}`}>
            {verification.label}
          </span>
        </div>
        <div className="mt-0.5 text-text-2">
          {data.sender?.replyTo ? `Replies go to ${data.sender.replyTo}.` : "Replies go to the sender address."}
          {data.sender?.mode === "voom_fallback" && (
            <span className="text-amber"> Your business name is shown, but the email is delivered from Voom’s managed address until your domain is verified.</span>
          )}
        </div>
        <div className="mt-0.5 text-text-3">
          From <b className="text-text-2">{data.subject || "(no subject)"}</b>
          {data.preheader ? <span> · {data.preheader}</span> : null}
        </div>
        {recipientNote && <div className="mt-1 text-[11.5px] text-text-3">{recipientNote}</div>}
      </div>

      {/* Quality guard — needs-attention items before anything can send. */}
      {data.quality && data.quality.failures && data.quality.failures.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2.5">
          <div className="text-[12.5px] font-semibold text-amber">
            Needs attention before sending — {data.quality.failures.length} check{data.quality.failures.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-1 list-disc pl-4 text-[12px] leading-relaxed text-text-2">
            {data.quality.failures.map((failure, index) => (
              <li key={`${failure.code}-${index}`}>{failure.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Rendered email — the exact production HTML (or its plain-text form). */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line">
        <div className="flex items-center justify-between border-b border-line bg-surface-2/60 px-2.5 py-1.5">
          <div className="inline-flex gap-1 rounded-lg border border-line bg-surface p-0.5">
            <button
              type="button"
              aria-pressed={device === "desktop"}
              onClick={() => setDevice("desktop")}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition ${device === "desktop" ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`}
            >
              Desktop
            </button>
            <button
              type="button"
              aria-pressed={device === "mobile"}
              onClick={() => setDevice("mobile")}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition ${device === "mobile" ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`}
            >
              Mobile
            </button>
          </div>
          <div className="inline-flex gap-1 rounded-lg border border-line bg-surface p-0.5">
            <button
              type="button"
              aria-pressed={!showText}
              onClick={() => setShowText(false)}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition ${!showText ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`}
            >
              Email
            </button>
            <button
              type="button"
              aria-pressed={showText}
              onClick={() => setShowText(true)}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition ${showText ? "bg-surface-2 text-text shadow-sm" : "text-text-3"}`}
            >
              Plain text
            </button>
          </div>
        </div>
        <div className="flex max-h-[420px] justify-center overflow-auto bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,rgba(0,0,0,0.02)_10px,rgba(0,0,0,0.02)_20px)] p-3">
          {showText ? (
            <pre className="w-full whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-2">{data.text}</pre>
          ) : (
            <iframe
              title="Email preview"
              srcDoc={data.html}
              sandbox=""
              className={`h-[400px] ${deviceClass} rounded-lg border border-line bg-white`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
