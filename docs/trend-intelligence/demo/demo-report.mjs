/**
 * Append the model-dependent part of the demo report without assuming the
 * provider returned usable content. Error output is deliberately restricted
 * to stable local codes; provider payloads and credentials never enter it.
 */
export function appendMaraPlannerReport(lines, trace) {
  lines.push("## MARA content planner (flag-gated)", "");

  if (trace.generation?.validation?.ok !== true) {
    const diagnostic = trace.generation?.diagnostic;
    lines.push(
      `- Generation: failed (${safeDemoErrorCode(trace.generation?.validation?.error)})`,
      `- Safe diagnostic: ${safeDiagnosticValue(diagnostic?.code)} at ${safeDiagnosticValue(diagnostic?.stage)}; transient=${diagnostic?.transient === true}`,
      "- No draft was accepted, validated, scheduled or published.",
      "",
    );
    return;
  }

  if (!trace.flag || !trace.mara || !trace.content || !trace.claimCheck) {
    lines.push(
      "- Generation: failed (demo_report_incomplete)",
      "- No draft was accepted, validated, scheduled or published.",
      "",
    );
    return;
  }

  lines.push(
    `- \`VOOM_TREND_CONTEXT_ENABLED\` default: ${trace.flag.defaultEnabled ? "ON" : "OFF"}`,
    `- Flag off → system prompt unchanged: ${trace.mara.flagOffSystemPromptUnchanged}; payload has trend block: ${trace.mara.flagOffPayloadHasTrend}`,
    "- Flag on → section appended to MARA's real system prompt:",
    "",
    "```text",
    trace.mara.systemPromptTrendSection,
    "```",
    "",
    "- Flag on → `trendOpportunity` in MARA's real payload:",
    "",
    "```json",
    JSON.stringify(trace.mara.payloadTrendOpportunity, null, 2),
    "```",
    "",
    `- Instagram post draft (**model reply ${trace.mara.modelReply}**):`,
    "",
    "```json",
    JSON.stringify(trace.content, null, 2),
    "```",
    "",
    `- Output validation: passed (${trace.generation.validation.checks})`,
    `- Unsupported-claim check: ${trace.claimCheck.clean ? "clean — no unsupported numbers, prices/discounts, partnership claims, links or guarantees found" : "FINDINGS:"}`,
    ...trace.claimCheck.findings.map((finding) => `  - ${finding.kind} in ${finding.field}: "${finding.text}"`),
    "",
  );
}

function safeDiagnosticValue(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unknown";
}

export function safeDemoErrorCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : "content_generation_failed";
}

/**
 * Return response-shape diagnostics only. Generated text, reasoning text,
 * prompts, headers and credentials are deliberately never copied.
 */
export function safeProviderResponseDiagnostic(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const message = choice?.message;
  const content = message?.content;
  const usage = body?.usage;
  return {
    finalContentExists: typeof content === "string",
    finalContentLength: typeof content === "string" ? content.length : 0,
    finishReason: safeDiagnosticValue(choice?.finish_reason),
    reasoningPresent: typeof message?.reasoning === "string"
      ? message.reasoning.length > 0
      : message?.reasoning != null || message?.reasoning_details != null,
    promptTokens: safeCount(usage?.prompt_tokens),
    completionTokens: safeCount(usage?.completion_tokens),
    reasoningTokens: safeCount(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
