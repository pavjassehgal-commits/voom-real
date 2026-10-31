-- Rollback for 0070: removes the slot generation leases. Leases hold no
-- content, so nothing customer-visible is lost. Deploy code without the lease
-- calls BEFORE running this, or Build/Replenish will fail closed.
drop function if exists public.release_plan_slot_generation(uuid, uuid, text, uuid);
drop function if exists public.plan_slot_lease_held(uuid, uuid, text, uuid, bigint);
drop function if exists public.claim_plan_slot_generation(uuid, uuid, text, integer);
drop table if exists public.plan_slot_generation_leases;
