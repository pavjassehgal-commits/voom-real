/**
 * Deterministic AI fixture for the first staging Replenish test with a
 * collected event (2026 Abu Dhabi Grand Prix). It stands in for MARA's model:
 * no network, no credits. It answers ONLY when MARA's real request carries the
 * reviewed trend context (proving the production loader delivered it), and it
 * writes from the context's verified facts and the business's own profile —
 * no popularity figures, offers, partnerships or invented dates.
 */
export const GP_TOPIC = "2026 Abu Dhabi Grand Prix";
export const TEST_BRAND = "Gulf Gloss Auto Detailing (TEST)";
export const TEST_OWNER_EMAIL = "trend-detailing-test@voom.today";

export function deterministicTrendProvider(captured) {
  return {
    async structured(request) {
      const payload = JSON.parse(request.messages[1].content);
      captured.push({ system: request.messages[0].content, payload });
      const trend = payload.trendOpportunity;
      if (!trend || trend.topic !== GP_TOPIC) throw new Error("fixture_missing_trend_context");
      const { channel, format } = payload.assignedSocialSlot;
      const video = format !== "post" && format !== "story";
      const business = String(payload.business?.name ?? TEST_BRAND);
      const when = "4-6 December 2026";
      return request.parse({
        concept: video ? `${GP_TOPIC} car prep video` : `${GP_TOPIC} car prep`,
        hook: video ? `Driving to Yas Marina for the ${GP_TOPIC}?` : "",
        caption: `The ${GP_TOPIC} takes place on ${when} at Yas Marina. Get your car detailed at ${business} before you drive to Abu Dhabi.`,
        cta: `Book a detail with ${business}.`,
        hashtags: format === "story" ? [] : ["CarDetailing", "AbuDhabi", "CeramicCoating"],
        description: channel === "youtube"
          ? `How ${business} prepares a car's paint and finish before the ${GP_TOPIC} weekend at Yas Marina.`
          : "",
        script: video
          ? [
              `Open on a car arriving at ${business} for a full detail.`,
              `Name the ${GP_TOPIC} at Yas Marina on ${when}.`,
              "Show the existing paint correction and ceramic coating steps.",
              "Close with how to book a detail; no event logos or partnership claims.",
            ]
          : [],
        visualBrief: video
          ? "Vertical footage of hand paint correction and a gloss finish under studio light; no text, no event logos."
          : "One close-up of a freshly detailed car's gloss finish under studio light; no text, no event logos.",
      });
    },
  };
}

/** Checks every captured MARA request carried the reviewed context. */
export function summarizeCaptured(captured) {
  const trendSection = captured.every((c) => /TREND EVIDENCE/.test(c.system));
  const topics = [...new Set(captured.map((c) => c.payload.trendOpportunity?.topic ?? null))];
  const formats = captured.map((c) => `${c.payload.assignedSocialSlot.channel}:${c.payload.assignedSocialSlot.format}`);
  return { requests: captured.length, allCarriedTrendSection: trendSection, topics, formats };
}
