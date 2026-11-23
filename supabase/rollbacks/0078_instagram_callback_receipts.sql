-- Rollback for 0078_instagram_callback_receipts.sql.
--
-- Safe only BEFORE any real callback has been accepted. It refuses to run when a
-- receipt exists, because receipts are evidence of Meta deletion requests VOOM
-- has acknowledged (confirmation codes already given to people). If receipts
-- exist, do not drop them: switch the callbacks off instead
-- (INSTAGRAM_LIFECYCLE_ENABLED=off, which makes both endpoints answer 503) and
-- finish any open deletion with the operator functions.
--
-- Rolling back never reconnects accounts a callback disconnected. That is
-- intentional: Meta has already revoked those authorisations; the person
-- reconnects from Channels if they want to.
--
-- Run the code rollback first (redeploy without the callback routes), then this.

begin;

do $$
begin
  if exists (select 1 from public.instagram_callback_receipts) then
    raise exception 'instagram_callback_receipts is not empty: keep the table, disable the callbacks instead';
  end if;
end
$$;

drop function if exists public.instagram_deletion_status(text);
drop function if exists public.complete_instagram_deletion(text, text, text, boolean, boolean, boolean, date);
drop function if exists public.erase_instagram_deletion_data(text);
drop function if exists public.accept_instagram_callback(text, text, text, timestamptz, text);
drop table if exists public.instagram_callback_receipts;

commit;
