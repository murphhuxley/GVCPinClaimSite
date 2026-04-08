-- Enforce one claimed code per wallet address while preserving NULL rows
-- for unclaimed codes.
create unique index if not exists claims_wallet_address_unique
  on public.claims (wallet_address)
  where wallet_address is not null;

-- Track every wallet or delegated vault that contributed to a successful claim.
-- This lets the claim site prevent a delegated vault from being reused across
-- multiple claimant wallets.
create table if not exists public.claim_sources (
  source_wallet text primary key,
  claimed_by_wallet text not null,
  claimed_at timestamptz not null default timezone('utc', now())
);

create index if not exists claim_sources_claimed_by_wallet_idx
  on public.claim_sources (claimed_by_wallet);
