import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  MAX_AI_REQUEST_TIMEOUT_MS,
  getAiConfig,
} = await import("../lib/ai/config.ts");

const configured = (timeout) => ({
  AI_PROVIDER: "openai-compatible",
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://provider.test/v1",
  AI_MODEL: "test-model",
  ...(timeout === undefined ? {} : { AI_REQUEST_TIMEOUT_MS: timeout }),
});

test("AI request timeout defaults to 30 seconds and accepts the local 90-second demo override", () => {
  assert.equal(DEFAULT_AI_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(getAiConfig(configured()).requestTimeoutMs, 30_000);
  assert.equal(getAiConfig(configured("90000")).requestTimeoutMs, 90_000);
});

test("AI request timeout rejects invalid values and caps valid values at 120 seconds", () => {
  assert.equal(MAX_AI_REQUEST_TIMEOUT_MS, 120_000);
  assert.equal(getAiConfig(configured("120001")).requestTimeoutMs, 120_000);
  for (const value of ["0", "-1", "1.5", "not-a-number"]) {
    assert.throws(
      () => getAiConfig(configured(value)),
      (error) => error?.code === "not_configured" && !String(error.message).includes(value),
      `invalid timeout ${value} must fail closed without echoing it`,
    );
  }
});

test("the OpenAI-compatible adapter uses the configured timeout for model and tool requests", async () => {
  const source = await readFile(new URL("../lib/ai/openai-compatible.ts", import.meta.url), "utf8");
  assert.equal((source.match(/AbortSignal\.timeout\(this\.config\.requestTimeoutMs \?\? 30_000\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /AbortSignal\.timeout\(30_000\)/);
});
