-- Shared rate-limit buckets for claim requests. This avoids per-instance
-- in-memory throttles in serverless environments.
create table if not exists public.claim_rate_limits (
  bucket text primary key,
  count integer not null,
  reset_at timestamptz not null
);

create index if not exists claim_rate_limits_reset_at_idx
  on public.claim_rate_limits (reset_at);

create or replace function public.consume_claim_rate_limit(
  bucket_key text,
  max_count integer,
  window_seconds integer
)
returns table (
  allowed boolean,
  current_count integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket_row public.claim_rate_limits%rowtype;
  now_ts timestamptz := timezone('utc', now());
  next_reset_at timestamptz := now_ts + make_interval(secs => window_seconds);
begin
  if max_count < 1 or window_seconds < 1 then
    raise exception 'max_count and window_seconds must be positive';
  end if;

  loop
    select *
      into bucket_row
      from public.claim_rate_limits
     where bucket = bucket_key
     for update;

    if found then
      if bucket_row.reset_at <= now_ts then
        update public.claim_rate_limits
           set count = 1,
               reset_at = next_reset_at
         where bucket = bucket_key;

        allowed := true;
        current_count := 1;
        reset_at := next_reset_at;
        return next;
        return;
      end if;

      if bucket_row.count >= max_count then
        allowed := false;
        current_count := bucket_row.count;
        reset_at := bucket_row.reset_at;
        return next;
        return;
      end if;

      update public.claim_rate_limits
         set count = bucket_row.count + 1
       where bucket = bucket_key;

      allowed := true;
      current_count := bucket_row.count + 1;
      reset_at := bucket_row.reset_at;
      return next;
      return;
    end if;

    begin
      insert into public.claim_rate_limits (bucket, count, reset_at)
      values (bucket_key, 1, next_reset_at);

      allowed := true;
      current_count := 1;
      reset_at := next_reset_at;
      return next;
      return;
    exception
      when unique_violation then
        -- Another request inserted the same bucket at the same time.
        -- Retry the locked read/update path above.
    end;
  end loop;
end;
$$;

revoke all on table public.claim_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.claim_rate_limits to service_role;

revoke all on function public.consume_claim_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_claim_rate_limit(text, integer, integer)
  to service_role;
