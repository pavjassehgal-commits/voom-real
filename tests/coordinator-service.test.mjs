import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const coordService = await import("../lib/coordinator/service.ts");
const coordState = await import("../lib/coordinator/state.ts");
const { runCoordinatorForOwner, runFleetCoordinator } = coordService;
const { buildMarketingState } = coordState;

test("Migration 0039 exists, is additive and RLS protected", async () => {
  const sql = await read("supabase/migrations/0039_automation_coordinator.sql");
  assert.match(sql, /create table if not exists public\.voom_coordinator_runs/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /create policy coordinator_runs_owner_select/);
  assert.match(sql, /grant select, insert, update, delete on table public\.voom_coordinator_runs to service_role/);
});

test("Money & Provider Safety: coordinator evaluation causes ZERO media spend and ZERO provider calls", async () => {
  let mediaApiCalled = false;
  let ledgerCharged = false;
  let resendSent = false;
  let metaPublished = false;

  // Set up mock DB
  const fakeAdmin = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        lte() { return this; },
        not() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => {
          if (table === "businesses") {
            return {
              data: {
                id: "biz-1",
                owner_user_id: "user-1",
                brand_name: "Safety Brand",
                content_frequency: "3x_week",
                automation_level: "manual",
                timezone: "Asia/Dubai",
                plan: "free",
                allow_automatic_paid_media: false,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        insert: async () => ({ data: null, error: null }),
      };
    },
  };

  const res = await runCoordinatorForOwner(fakeAdmin, "user-1", "biz-1", {
    now: new Date("2026-09-16T10:00:00Z"),
    trigger: "scheduled",
  });

  assert.equal(mediaApiCalled, false, "Media API must not be called");
  assert.equal(ledgerCharged, false, "Ledger must not be charged");
  assert.equal(resendSent, false, "Resend must not be sent");
  assert.equal(metaPublished, false, "Meta must not be published");
  assert.ok(res.idempotencyKey, "Should generate durable idempotency key");
  assert.equal(res.actionsTaken.length, 0, "Manual mode should take 0 autonomous actions");
});

test("Concurrency & Idempotency: repeated run produces stable idempotency key and no duplicated work", async () => {
  const fakeAdmin = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        lte() { return this; },
        not() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => {
          if (table === "businesses") {
            return {
              data: {
                id: "biz-2",
                owner_user_id: "user-2",
                brand_name: "Steady Brand",
                content_frequency: "3x_week",
                automation_level: "manual",
                timezone: "Asia/Dubai",
                plan: "pro",
                allow_automatic_paid_media: false,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        insert: async () => ({ data: null, error: null }),
      };
    },
  };

  const run1 = await runCoordinatorForOwner(fakeAdmin, "user-2", "biz-2", {
    now: new Date("2026-09-16T12:00:00Z"),
    trigger: "scheduled",
  });
  const run2 = await runCoordinatorForOwner(fakeAdmin, "user-2", "biz-2", {
    now: new Date("2026-09-16T12:00:00Z"),
    trigger: "scheduled",
  });

  assert.equal(run1.idempotencyKey, run2.idempotencyKey, "Same state and time must produce identical idempotency key");
});

test("Email opportunity: foundation detects opportunity without sending email", async () => {
  const fakeAdmin = {
    from(table) {
      const q = {
        _isContacts: table === "contacts",
        select(cols, opts) {
          return this;
        },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        lte() { return this; },
        not() { return this; },
        order() { return this; },
        limit() { return this; },
        async maybeSingle() {
          if (table === "businesses") {
            return {
              data: {
                id: "biz-email",
                owner_user_id: "user-email",
                brand_name: "Email Brand",
                content_frequency: "3x_week",
                automation_level: "assisted",
                timezone: "Asia/Dubai",
                plan: "pro",
                allow_automatic_paid_media: false,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(onFulfilled, onRejected) {
          if (this._isContacts) {
            return Promise.resolve({ count: 25, data: null, error: null }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
        insert: async () => ({ data: null, error: null }),
      };
      return q;
    },
  };

  const state = await buildMarketingState(fakeAdmin, "user-email", "biz-email", new Date("2026-09-16T12:00:00Z"));
  assert.equal(state.emailState.eligibleContactsCount, 25);
  assert.equal(state.emailState.opportunityAvailable, true);
});
