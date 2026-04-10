-- Manual claim recovery helpers for the GVC pin claim flow.
--
-- Use these in Supabase SQL Editor when you need to inspect or undo a claim.
-- All wallet addresses should be pasted in lowercase to match app storage.
--
-- IMPORTANT:
-- Only use the "release back to pool" flow if the Shopify code has NOT been
-- redeemed. Shopify codes are single-use, so releasing a redeemed code back into
-- the claims pool would hand out a dead code to the next claimant.

-- ---------------------------------------------------------------------------
-- 1. Inspect the current claim state for a wallet
-- ---------------------------------------------------------------------------

select id, discount_code, wallet_address, claimed_at
from public.claims
where wallet_address = lower('0xreplace_me');

select source_wallet, claimed_by_wallet, claimed_at
from public.claim_sources
where claimed_by_wallet = lower('0xreplace_me')
   or source_wallet = lower('0xreplace_me')
order by claimed_at desc;

-- ---------------------------------------------------------------------------
-- 2. Release an UNREDEEMED claim back to the pool
-- ---------------------------------------------------------------------------
--
-- Only run this if you are sure the code was not used in Shopify.
-- This clears the wallet assignment and frees the linked source wallets.

begin;

update public.claims
set wallet_address = null,
    claimed_at = null
where wallet_address = lower('0xreplace_me');

delete from public.claim_sources
where claimed_by_wallet = lower('0xreplace_me');

commit;

-- Verify the reset:
select id, discount_code, wallet_address, claimed_at
from public.claims
where wallet_address = lower('0xreplace_me');

select source_wallet, claimed_by_wallet, claimed_at
from public.claim_sources
where claimed_by_wallet = lower('0xreplace_me');

-- ---------------------------------------------------------------------------
-- 3. If the code WAS redeemed in Shopify
-- ---------------------------------------------------------------------------
--
-- Do NOT release the old code back to the pool.
-- Instead:
--   1. create a fresh replacement code in Shopify
--   2. clear the old claim_sources rows
--   3. manually decide whether to keep the old code row attached as history
--      or replace it offline with a new code before letting the wallet reclaim
--
-- Helpful query to see which code was assigned:

select discount_code
from public.claims
where wallet_address = lower('0xreplace_me');
