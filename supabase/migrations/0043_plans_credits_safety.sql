begin;

-- Secure businesses.plan against client-side escalation
create or replace function public.protect_business_plan()
returns trigger
language plpgsql
security definer
as $$
begin
  if current_user in ('anon', 'authenticated') or nullif(current_setting('request.jwt.claims', true), '') is not null then
    -- Using auth.role() safely through jwt claims or current_user
    declare
      v_role text := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb->>'role', current_user);
    begin
      if v_role in ('anon', 'authenticated') then
        if TG_OP = 'INSERT' then
          if new.plan != 'free' then
            raise exception 'Cannot escalate plan during insertion';
          end if;
        elsif TG_OP = 'UPDATE' then
          if new.plan is distinct from old.plan then
            raise exception 'Cannot modify plan via client API';
          end if;
        end if;
      end if;
    end;
  end if;
  
  return new;
end;
$$;

drop trigger if exists ensure_business_plan_protected on public.businesses;
create trigger ensure_business_plan_protected
  before insert or update on public.businesses
  for each row execute function public.protect_business_plan();

-- Explicitly secure voom_credit_ledger table privileges
revoke all on table public.voom_credit_ledger from anon, authenticated, public;

-- Allow authenticated users to SELECT (RLS limits to own rows)
grant select on table public.voom_credit_ledger to authenticated;

-- Ensure service_role has all permissions
grant all on table public.voom_credit_ledger to service_role;

-- Explicitly secure credit RPCs
revoke all on function public.reserve_media_credits(uuid,text,text,integer,text) from anon, authenticated, public;
revoke all on function public.refund_media_credits(uuid,text) from anon, authenticated, public;
revoke all on function public.settle_media_credits(uuid,text) from anon, authenticated, public;
revoke all on function public.voom_plan_allowance(uuid) from anon, authenticated, public;

-- Grant execution to service_role
grant execute on function public.reserve_media_credits(uuid,text,text,integer,text) to service_role;
grant execute on function public.refund_media_credits(uuid,text) to service_role;
grant execute on function public.settle_media_credits(uuid,text) to service_role;
grant execute on function public.voom_plan_allowance(uuid) to service_role;

commit;
