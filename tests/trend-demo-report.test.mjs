import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appendMaraPlannerReport, safeDemoErrorCode, safeProviderResponseDiagnostic } from "../docs/trend-intelligence/demo/demo-report.mjs";

test("failed live generation produces a safe report without MARA output objects", () => {
  const lines = [];
  assert.doesNotThrow(() => appendMaraPlannerReport(lines, {
    generation: {
      mode: "live",
      diagnostic: { code: "malformed_response", stage: "structured_json_parse", transient: true },
      validation: { ok: false, error: "content_generation_failed" },
    },
  }));
  const report = lines.join("\n");
  assert.match(report, /Generation: failed \(content_generation_failed\)/);
  assert.match(report, /Safe diagnostic: malformed_response at structured_json_parse; transient=true/);
  assert.match(report, /No draft was accepted, validated, scheduled or published/);
  assert.doesNotMatch(report, /undefined|API_API_KEY|Authorization|Bearer/);
});

test("demo error reporting permits stable codes and suppresses arbitrary provider text", () => {
  assert.equal(safeDemoErrorCode("content_rate_limited"), "content_rate_limited");
  assert.equal(safeDemoErrorCode("provider said secret=abc"), "content_generation_failed");
  assert.equal(safeDemoErrorCode(undefined), "content_generation_failed");
});

test("an incomplete success trace fails safely instead of dereferencing absent output", () => {
  const lines = [];
  appendMaraPlannerReport(lines, { generation: { validation: { ok: true, checks: "schema" } } });
  assert.match(lines.join("\n"), /demo_report_incomplete/);
});

test("the live runner delegates optional output safely and writes the report afterward", async () => {
  const source = await readFile(new URL("../docs/trend-intelligence/demo/run-demo.mjs", import.meta.url), "utf8");
  const appendAt = source.indexOf("appendMaraPlannerReport(lines, t)");
  const writeAt = source.indexOf("writeFileSync(new URL(live ? \"./DEMO-OUTPUT-LIVE.md\"");
  assert.ok(appendAt >= 0 && writeAt > appendAt, "failure-safe rendering must complete before the live report is written");
  assert.doesNotMatch(source, /t\.(mara|content|claimCheck)\b/, "the runner must not directly dereference optional model results");
  assert.match(source, /usage\.attempts >= 1/, "the one-request circuit breaker remains active");
});

test("provider diagnostics retain shape and counts but never model or reasoning content", () => {
  const diagnostic = safeProviderResponseDiagnostic({
    model: "secret-model-label",
    choices: [{ finish_reason: "length", message: { content: "private generated text", reasoning: "private chain of thought" } }],
    usage: { prompt_tokens: 125, completion_tokens: 2200, completion_tokens_details: { reasoning_tokens: 2050 } },
  });
  assert.deepEqual(diagnostic, {
    finalContentExists: true,
    finalContentLength: 22,
    finishReason: "length",
    reasoningPresent: true,
    promptTokens: 125,
    completionTokens: 2200,
    reasoningTokens: 2050,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|chain of thought/);
});
