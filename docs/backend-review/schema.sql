-- GVC Pin Claim — Database Schema
--
-- The `claims` table is pre-loaded with discount codes (wallet_address = NULL).
-- When a holder claims, the row is updated with their wallet address.
-- The partial unique index ensures one code per wallet.

-- Enforce one claimed code per wallet (NULLs are excluded, so unclaimed rows coexist)
CREATE UNIQUE INDEX IF NOT EXISTS claims_wallet_address_unique
  ON public.claims (wallet_address)
  WHERE wallet_address IS NOT NULL;

-- Track which wallets contributed to each claim.
-- Prevents a delegated vault from being reused across multiple claimants.
CREATE TABLE IF NOT EXISTS public.claim_sources (
  source_wallet      TEXT PRIMARY KEY,
  claimed_by_wallet  TEXT NOT NULL,
  claimed_at         TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS claim_sources_claimed_by_wallet_idx
  ON public.claim_sources (claimed_by_wallet);
