-- Rollback for 0071: removes the automation mode entitlement guard. No data is
-- changed. The app-level checks (onboarding and /api/automation-mode) remain.
drop trigger if exists ensure_business_automation_mode_entitled on public.businesses;
drop function if exists public.protect_business_automation_mode();
