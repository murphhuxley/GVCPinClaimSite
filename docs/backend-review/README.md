# GVC Pin Claim — Backend Review

These files contain the core backend logic for the GVC Pin Claim site. The site lets holders of all 3 "Cosmic High Key Moments" ERC-1155 tokens claim a free pin pack via a discount code.

## Architecture

```
User connects wallet
        │
        ▼
  POST /api/claim (intent: "check")
  ── Server reads on-chain balances (ERC-1155)
  ── Checks delegate.xyz for vault delegations
  ── Returns eligibility status
        │
        ▼
  POST /api/claim (intent: "challenge")
  ── Server issues a signed, time-limited challenge
  ── Client signs with wallet (EIP-191)
        │
        ▼
  POST /api/claim (intent: "claim")
  ── Server verifies HMAC + wallet signature
  ── Assigns next available discount code from Supabase
  ── Reserves source wallets to prevent reuse
  ── Returns discount code
```

## Files

| File | Purpose |
|------|---------|
| `claim-route.ts` | Main API route — rate limiting, challenge-response auth, code assignment |
| `contracts.ts` | On-chain eligibility checks — ERC-1155 balance reads, delegate.xyz vault discovery |
| `schema.sql` | Database schema — claims table constraint + claim_sources anti-reuse table |

## Key Security Properties

- **Server-side eligibility** — on-chain reads happen server-side, never trusting client claims
- **Challenge-response auth** — HMAC-signed challenges with wallet signature verification (EIP-191)
- **Timing-safe comparison** — HMAC proofs compared with `timingSafeEqual`
- **Rate limiting** — per-IP and per-wallet limits on all endpoints
- **Optimistic locking** — `UPDATE ... WHERE wallet_address IS NULL` prevents double-assignment
- **Retry logic** — 3 attempts for concurrent claim races
- **Delegate vault locking** — `claim_sources` table prevents a vault from being reused across wallets
- **1-hour challenge expiry** — accommodates multi-wallet flows while limiting replay window

## Tech Stack

- Next.js API Routes (App Router)
- Supabase (Postgres) for discount code storage
- viem for on-chain reads (Ethereum mainnet)
- delegate.xyz v2 for vault delegation lookups
