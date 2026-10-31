/**
 * In-memory stand-in for migration 0070's slot generation lease RPCs, for test
 * fakes that are not backed by Postgres. Same contract: one live lease per
 * (owner, plan, slot), takeover only after expiry with a higher fence, and
 * `held` checks lease id + fence + expiry. The real SQL is exercised against
 * PGlite in tests/mara-slot-lease-db.test.mjs.
 *
 * Returns `{ data, error }` for a lease RPC, or null for any other name.
 */
import { randomUUID } from "node:crypto";

export function planSlotLeaseRpc(leases = new Map(), now = () => Date.now()) {
  return function handle(name, args = {}) {
    const key = `${args.p_owner_user_id}|${args.p_plan_id}|${args.p_slot_key}`;
    if (name === "claim_plan_slot_generation") {
      if (!Number.isInteger(args.p_lease_seconds) || args.p_lease_seconds < 10 || args.p_lease_seconds > 600) {
        return { data: null, error: { message: "invalid_plan_slot_lease" } };
      }
      const current = leases.get(key);
      if (current && current.leasedUntil > now()) return { data: [], error: null };
      const next = { leaseId: randomUUID(), fence: (current?.fence ?? 0) + 1, leasedUntil: now() + args.p_lease_seconds * 1000 };
      leases.set(key, next);
      return { data: [{ lease_id: next.leaseId, fence: next.fence }], error: null };
    }
    if (name === "plan_slot_lease_held") {
      const current = leases.get(key);
      return {
        data: Boolean(current && current.leaseId === args.p_lease_id && current.fence === Number(args.p_fence) && current.leasedUntil > now()),
        error: null,
      };
    }
    if (name === "release_plan_slot_generation") {
      const current = leases.get(key);
      const live = Boolean(current && current.leaseId === args.p_lease_id && current.leasedUntil > now());
      if (live) current.leasedUntil = now();
      return { data: live, error: null };
    }
    return null;
  };
}
