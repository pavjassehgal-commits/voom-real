"use client";

import { useState } from "react";

import { Btn, Card, Field, Input, Tag, Textarea, cx } from "../ui/primitives";
import { Icon } from "../icons";

type PreviewMode = "html" | "text";

export interface PrimingPreviewResponse {
  preview?: {
    subject: string;
    preheader: string;
    html: string;
    text: string;
    fromName?: string;
    fromAddress?: string;
  };
  error?: string;
}

/**
 * Branded Email preview: renders a draft primed with the business's own
 * subject/body through the SAME deterministic renderer production sends with
 * (`/api/voom/email-brand/preview`). Shows the resolved sender identity, the
 * rendered email and the plain-text alternative. Never sends anything.
 */
export function PrimingPreview() {
  const [subject, setSubject] = useState("");
  const [preline, setPreline] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrimingPreviewResponse["preview"] | null>(null);
  const [mode, setMode] = useState<PreviewMode>("html");

  const disabled = loading || !subject.trim() || !body.trim();

  async function renderPreview() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/voom/email-brand/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          previewText: preline,
          body,
          cta: ctaLabel,
        }),
      });
      const data: PrimingPreviewResponse = await res.json();
      if (!res.ok || !data.preview) {
        setError(data.error ?? "That preview could not be rendered.");
        return;
      }
      setResult(data.preview);
    } catch {
      setError("That preview could not be rendered.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="mb-3.5 p-4">
      <h2 className="mb-1.5 font-display text-lg font-semibold">Email preview</h2>
      <p className="mb-3.5 text-[12.5px] leading-relaxed text-text-3">
        Rendered with the same engine Voom sends through: hero, brand color, CTA and footer
        come from your business profile. Nothing here is ever sent — Voom only emails
        recipients when you explicitly send.
      </p>

      <Field label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your subject line" />
      </Field>
      <Field label="Preheader" hint="The short line under the subject in a recipient's inbox. Optional.">
        <Input value={preline} onChange={(e) => setPreline(e.target.value)} placeholder="A one-line summary of the email" />
      </Field>
      <Field
        label="Email body"
        hint="Start with a greeting on its own line — like “Hi {firstName},”. Blank lines split the rest into sections."
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={"Hi {firstName},\n\nWrite your message here…"}
          rows={6}
        />
      </Field>
      <Field label="Call to action" hint="Optional. The button links to your verified business website.">
        <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Open the dashboard" />
      </Field>

      <Btn variant="primary" size="sm" onClick={renderPreview} disabled={disabled}>
        {loading ? "Rendering…" : "Render preview"}
      </Btn>

      {error && (
        <div role="alert" className="mt-3 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold">{result.subject || " "}</div>
              <div className="truncate text-[12.5px] text-text-3">
                {result.fromName || "Your business"}
                {result.fromAddress ? ` <${result.fromAddress}>` : ""}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMode("html")}
                className={cx(
                  "rounded-[9px] px-3 py-1.5 text-[12.5px] font-semibold",
                  mode === "html" ? "bg-surface-2 text-text" : "text-text-3 hover:text-text",
                )}
              >
                Rendered
              </button>
              <button
                type="button"
                onClick={() => setMode("text")}
                className={cx(
                  "rounded-[9px] px-3 py-1.5 text-[12.5px] font-semibold",
                  mode === "text" ? "bg-surface-2 text-text" : "text-text-3 hover:text-text",
                )}
              >
                Plain text
              </button>
            </div>
          </div>

          {result.preheader && (
            <div className="flex flex-wrap gap-1.5">
              <Tag tone="t-grey">Preheader</Tag>
              <span className="text-[12.5px] leading-relaxed text-text-3">{result.preheader}</span>
            </div>
          )}

          {mode === "html" ? (
            <div
              className="overflow-hidden rounded-xl border border-line bg-white"
              style={{ maxHeight: 560, overflowY: "auto" }}
              title="Rendered email"
              // Renderer output is script-free and validated before it reaches
              // production, so showing it inline executes nothing.
              dangerouslySetInnerHTML={{ __html: result.html }}
            />
          ) : (
            <pre
              className="overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed text-text whitespace-pre-wrap"
              style={{ maxHeight: 560 }}
            >
              {result.text}
            </pre>
          )}

          <p className="flex items-start gap-1.5 text-[12px] text-text-3">
            <Icon name="info" size={13} className="mt-[1px]" />
            One responsive email, shown here in both its forms — rendered and plain text.
          </p>
        </div>
      )}
    </Card>
  );
}
