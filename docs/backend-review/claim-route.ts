/**
 * GVC Pin Claim — API Route
 *
 * POST /api/claim
 *
 * Handles three intents:
 *   "check"     — verify on-chain eligibility (no auth required)
 *   "challenge" — issue a signed challenge for wallet proof
 *   "claim"     — verify wallet signature + assign discount code
 *
 * Security model:
 *   - All eligibility checks are server-side on-chain reads
 *   - Claims require HMAC-signed challenge + EIP-191 wallet signature
 *   - Rate limited per IP and per wallet
 *   - Discount codes assigned via optimistic locking with retries
 *   - Delegate wallets locked via claim_sources to prevent reuse
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAddress, isAddress, verifyMessage } from "viem";
import {
  checkEligibility,
  checkMultiWalletEligibility,
  checkEligibilityWithDelegates,
} from "@/lib/contracts";

// ─── Types ───────────────────────────────────────────────────────────

type ClaimIntent = "challenge" | "check" | "claim";
type SupabaseAdminClient = SupabaseClient<any, "public", any>;

type ClaimChallenge = {
  address: string;    // source wallet (the one holding tokens)
  claimant: string;   // wallet receiving the code (may differ in delegate flows)
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

type ClaimProofPayload = {
  challenge: string;  // base64url-encoded challenge
  proof: string;      // HMAC signature of the challenge
  signature: string;  // EIP-191 wallet signature
};

type DelegateProofPayload = ClaimProofPayload & {
  address: string;    // the delegate wallet that signed
};

// ─── Rate Limiting ───────────────────────────────────────────────────

type RateLimitBucket = { count: number; resetAt: number };

declare global {
  var __gvcClaimRateLimits: Map<string, RateLimitBucket> | undefined;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const RATE_LIMITS: Record<ClaimIntent | "check", { perIp: number; perWallet: number }> = {
  challenge: { perIp: 24, perWallet: 12 },
  check:     { perIp: 90, perWallet: 30 },
  claim:     { perIp: 18, perWallet: 6 },
};

function getRateLimitStore(): Map<string, RateLimitBucket> {
  if (!globalThis.__gvcClaimRateLimits) {
    globalThis.__gvcClaimRateLimits = new Map();
  }
  return globalThis.__gvcClaimRateLimits;
}

function getClientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const store = getRateLimitStore();
  const bucket = store.get(key);

  if (!bucket || bucket.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= limit) return false;

  bucket.count += 1;
  store.set(key, bucket);
  return true;
}

function consumeRateLimit(req: NextRequest, intent: ClaimIntent | "check", wallet: string): boolean {
  const ip = getClientIp(req);
  const limits = RATE_LIMITS[intent];
  return (
    checkRateLimit(`ip:${intent}:${ip}`, limits.perIp) &&
    checkRateLimit(`wallet:${intent}:${wallet}`, limits.perWallet)
  );
}

// ─── Challenge-Response Auth ─────────────────────────────────────────

function getClaimAuthSecret(): string | null {
  return process.env.CLAIM_AUTH_SECRET || process.env.SUPABASE_SERVICE_KEY || null;
}

function encodeChallenge(challenge: ClaimChallenge): string {
  return Buffer.from(JSON.stringify(challenge)).toString("base64url");
}

function decodeChallenge(serialized: string): ClaimChallenge | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(serialized, "base64url").toString("utf8")
    ) as Partial<ClaimChallenge>;

    if (
      typeof parsed.address !== "string" ||
      typeof parsed.claimant !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) return null;

    return parsed as ClaimChallenge;
  } catch {
    return null;
  }
}

function signChallenge(serialized: string, secret: string): string {
  return createHmac("sha256", secret).update(serialized).digest("base64url");
}

function proofsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildClaimSigningMessage(challenge: ClaimChallenge): string {
  return [
    "Good Vibes Club Pin Pack Claim",
    "",
    "Sign this message to prove wallet ownership and claim or reveal your discount code.",
    "",
    `Wallet: ${getAddress(challenge.address)}`,
    `Claim Wallet: ${getAddress(challenge.claimant)}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expires At: ${challenge.expiresAt}`,
  ].join("\n");
}

function createClaimChallenge(address: string, claimant: string = address) {
  const secret = getClaimAuthSecret();
  if (!secret) return null;

  const payload: ClaimChallenge = {
    address,
    claimant,
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
  };
  const serialized = encodeChallenge(payload);

  return {
    challenge: serialized,
    proof: signChallenge(serialized, secret),
    signingMessage: buildClaimSigningMessage(payload),
    expiresAt: payload.expiresAt,
  };
}

async function verifyClaimProof(
  wallet: string,
  payload: ClaimProofPayload,
  claimant: string = wallet
): Promise<boolean> {
  const secret = getClaimAuthSecret();
  if (!secret) return false;

  const challenge = decodeChallenge(payload.challenge);
  if (!challenge) return false;
  if (challenge.address !== wallet || challenge.claimant !== claimant) return false;

  const expiresAt = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expectedProof = signChallenge(payload.challenge, secret);
  if (!proofsMatch(expectedProof, payload.proof)) return false;

  try {
    return await verifyMessage({
      address: getAddress(wallet),
      message: buildClaimSigningMessage(challenge),
      signature: payload.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// ─── Delegate Wallet Verification ────────────────────────────────────

async function getVerifiedDelegateAddresses(
  primaryWallet: string,
  rawDelegates: unknown
): Promise<string[]> {
  if (!Array.isArray(rawDelegates)) return [];

  const verified: string[] = [];

  for (const raw of rawDelegates.slice(0, 9)) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Partial<DelegateProofPayload>;

    if (typeof d.address !== "string" || !isAddress(d.address)) continue;

    const normalized = getAddress(d.address).toLowerCase();
    if (
      normalized === primaryWallet ||
      verified.includes(normalized) ||
      typeof d.challenge !== "string" ||
      typeof d.proof !== "string" ||
      typeof d.signature !== "string"
    ) continue;

    const valid = await verifyClaimProof(
      normalized,
      { challenge: d.challenge, proof: d.proof, signature: d.signature },
      primaryWallet
    );
    if (valid) verified.push(normalized);
  }

  return verified;
}

// ─── Supabase Operations ─────────────────────────────────────────────

function getSupabaseAdmin(): SupabaseAdminClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient<any>(url, key);
}

async function getExistingClaim(supabase: SupabaseAdminClient, wallet: string) {
  const { data, error } = await supabase
    .from("claims")
    .select("discount_code")
    .eq("wallet_address", wallet)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getClaimedWallets(supabase: SupabaseAdminClient, wallets: string[]): Promise<string[]> {
  if (wallets.length === 0) return [];
  const { data, error } = await supabase
    .from("claims")
    .select("wallet_address")
    .in("wallet_address", wallets)
    .not("wallet_address", "is", null);
  if (error) throw error;
  return (data || []).map((r: any) => r.wallet_address);
}

async function getNextAvailableCode(supabase: SupabaseAdminClient) {
  const { data, error } = await supabase
    .from("claims")
    .select("id, discount_code")
    .is("wallet_address", null)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Assign the next available discount code to a wallet.
 *
 * Uses optimistic locking: UPDATE ... WHERE wallet_address IS NULL
 * ensures two concurrent requests can't claim the same code.
 * Retries up to 3 times for race conditions.
 */
async function assignDiscountCode(
  supabase: SupabaseAdminClient,
  wallet: string
): Promise<{ status: "claimed"; code: string } | { status: "sold_out" } | { status: "retry" }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const available = await getNextAvailableCode(supabase);
    if (!available) return { status: "sold_out" };

    const { data, error } = await supabase
      .from("claims")
      .update({ wallet_address: wallet, claimed_at: new Date().toISOString() })
      .eq("id", available.id)
      .is("wallet_address", null)  // optimistic lock
      .select("discount_code")
      .maybeSingle();

    if (error) throw error;
    if (data?.discount_code) return { status: "claimed", code: data.discount_code };

    // Another request grabbed this code — check if it was us
    const existing = await getExistingClaim(supabase, wallet);
    if (existing?.discount_code) return { status: "claimed", code: existing.discount_code };
  }

  // Final check after retries exhausted
  const existing = await getExistingClaim(supabase, wallet);
  if (existing?.discount_code) return { status: "claimed", code: existing.discount_code };

  const remaining = await getNextAvailableCode(supabase);
  return remaining ? { status: "retry" } : { status: "sold_out" };
}

// ─── Source Wallet Locking (Multi-Wallet Claims) ─────────────────────

/**
 * When a claim uses tokens from multiple wallets (via delegate.xyz or
 * manual delegate proofs), we lock each source wallet in claim_sources
 * so it can't be reused for another claimant's claim.
 */

function getClaimSourceWallets(
  primaryWallet: string,
  perWallet: Record<string, boolean[]>
): string[] {
  const available = Object.entries(perWallet).filter(([, held]) => held.some(Boolean));
  if (available.length === 0) return [primaryWallet];

  // Greedy set cover: pick fewest wallets that cover all 3 tokens
  const ordered = available.sort(([a, hA], [b, hB]) => {
    if (a === primaryWallet) return -1;
    if (b === primaryWallet) return 1;
    return hB.filter(Boolean).length - hA.filter(Boolean).length;
  });

  const selected = new Set<string>();
  const covered = [false, false, false];

  while (!covered.every(Boolean)) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [wallet, held] of ordered) {
      if (selected.has(wallet)) continue;
      const uncovered = held.reduce((n, h, i) => n + (h && !covered[i] ? 1 : 0), 0);
      if (uncovered > bestCount) { bestCount = uncovered; best = wallet; }
    }
    if (!best || bestCount === 0) break;
    selected.add(best);
    (perWallet[best] || []).forEach((h, i) => { if (h) covered[i] = true; });
  }

  return covered.every(Boolean) ? Array.from(selected) : [primaryWallet];
}

async function reserveClaimSources(
  supabase: SupabaseAdminClient,
  sourceWallets: string[],
  claimantWallet: string
): Promise<{ status: "reserved" } | { status: "conflict"; sourceWallet: string } | { status: "unavailable" }> {
  if (sourceWallets.length === 0) return { status: "reserved" };

  const { data, error } = await supabase
    .from("claim_sources")
    .select("source_wallet, claimed_by_wallet")
    .in("source_wallet", sourceWallets);

  if (error) {
    if (error.message?.includes("does not exist")) return { status: "unavailable" };
    throw error;
  }

  const existing = (data || []) as { source_wallet: string; claimed_by_wallet: string }[];
  const conflict = existing.find(r => r.claimed_by_wallet !== claimantWallet);
  if (conflict) return { status: "conflict", sourceWallet: conflict.source_wallet };

  const alreadyReserved = new Set(existing.map(r => r.source_wallet));
  const toInsert = sourceWallets.filter(w => !alreadyReserved.has(w));
  if (toInsert.length === 0) return { status: "reserved" };

  const { error: insertError } = await supabase.from("claim_sources").insert(
    toInsert.map(w => ({
      source_wallet: w,
      claimed_by_wallet: claimantWallet,
      claimed_at: new Date().toISOString(),
    }))
  );

  if (!insertError) return { status: "reserved" };
  if (insertError.message?.includes("does not exist")) return { status: "unavailable" };
  throw insertError;
}

async function releaseClaimSources(
  supabase: SupabaseAdminClient,
  sourceWallets: string[],
  claimantWallet: string
): Promise<void> {
  if (sourceWallets.length === 0) return;
  await supabase
    .from("claim_sources")
    .delete()
    .eq("claimed_by_wallet", claimantWallet)
    .in("source_wallet", sourceWallets);
}

// ─── Main Route Handler ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const address = typeof body?.address === "string" ? body.address : "";
    const claimantAddress = typeof body?.claimantAddress === "string" ? body.claimantAddress : address;
    const intent: ClaimIntent = body?.intent === "claim" || body?.intent === "challenge" ? body.intent : "check";

    if (!isAddress(address)) return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    if (!isAddress(claimantAddress)) return NextResponse.json({ error: "Invalid claim wallet address" }, { status: 400 });

    const wallet = getAddress(address).toLowerCase();
    const claimantWallet = getAddress(claimantAddress).toLowerCase();

    if (!consumeRateLimit(req, intent, wallet)) {
      return NextResponse.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429 });
    }

    // ── Challenge: issue a signed challenge for wallet proof ──
    if (intent === "challenge") {
      const challenge = createClaimChallenge(wallet, claimantWallet);
      if (!challenge) return NextResponse.json({ error: "Claim signing is not configured." }, { status: 500 });
      return NextResponse.json(challenge);
    }

    const supabase = getSupabaseAdmin();

    // ── Claim: verify wallet proof before proceeding ──
    if (intent === "claim") {
      const { signature, challenge, proof } = body;
      const valid = await verifyClaimProof(wallet, { signature, challenge, proof }, wallet);
      if (!valid) return NextResponse.json({ error: "Wallet signature verification failed." }, { status: 401 });

      if (supabase) {
        const existing = await getExistingClaim(supabase, wallet);
        if (existing?.discount_code) {
          return NextResponse.json({ eligible: true, claimed: true, code: existing.discount_code });
        }
      }
    }

    // ── On-chain eligibility (server-side reads) ──
    const verifiedDelegates = await getVerifiedDelegateAddresses(wallet, body?.delegateProofs);
    const delegateResult = await checkEligibilityWithDelegates(getAddress(address));

    // Merge delegate.xyz vaults with manually-proven delegates
    const manualDelegates = verifiedDelegates.filter(
      addr => !delegateResult.delegateVaults.includes(addr) && addr !== wallet
    );

    let eligible: boolean, held: boolean[], walletHeld: boolean[], perWallet: Record<string, boolean[]>;

    if (delegateResult.eligible) {
      ({ eligible, held, walletHeld, perWallet } = delegateResult);
    } else if (manualDelegates.length > 0) {
      const all = [wallet, ...delegateResult.delegateVaults, ...manualDelegates];
      const combined = await checkMultiWalletEligibility(all);
      eligible = combined.eligible;
      held = combined.held;
      walletHeld = combined.perWallet[wallet] || delegateResult.walletHeld;
      perWallet = combined.perWallet;
    } else {
      ({ eligible, held, walletHeld, perWallet } = delegateResult);
    }

    const claimSourceWallets = eligible ? getClaimSourceWallets(wallet, perWallet) : [];

    if (!eligible) {
      return NextResponse.json({
        eligible: false, held, walletHeld,
        delegateVaults: delegateResult.delegateVaults,
        message: "You need all 3 HighKey Moments tokens to claim",
      });
    }

    if (!supabase) {
      return NextResponse.json({
        eligible: true, held, walletHeld, claimed: false, claimable: false, soldOut: false,
        message: "Eligible! Discount codes not yet loaded — check back soon.",
      });
    }

    // ── Check intent: return eligibility without claiming ──
    if (intent === "check") {
      const available = await getNextAvailableCode(supabase);
      return NextResponse.json({
        eligible: true, held, walletHeld, claimed: false, claimable: true,
        soldOut: !available,
        message: available
          ? "You're eligible to claim your free pin pack. Sign with your wallet to continue."
          : "New claims are sold out.",
      });
    }

    // ── Claim: assign code with anti-reuse locking ──
    const existing = await getExistingClaim(supabase, wallet);
    if (existing?.discount_code) {
      return NextResponse.json({ eligible: true, held, walletHeld, claimed: true, code: existing.discount_code });
    }

    // Check source wallets haven't already been used
    const alreadyClaimed = await getClaimedWallets(
      supabase, claimSourceWallets.filter(w => w !== wallet)
    );
    if (alreadyClaimed.length > 0) {
      return NextResponse.json(
        { error: "One of the wallets used for this claim has already claimed a pin pack." },
        { status: 409 }
      );
    }

    // Reserve source wallets
    const reservation = await reserveClaimSources(supabase, claimSourceWallets, wallet);
    if (reservation.status === "conflict") {
      return NextResponse.json(
        { error: "A wallet used for this claim is already reserved by another claimant." },
        { status: 409 }
      );
    }

    // Assign next available code (with retries for concurrent claims)
    let result: Awaited<ReturnType<typeof assignDiscountCode>>;
    try {
      result = await assignDiscountCode(supabase, wallet);
    } catch (err) {
      if (reservation.status === "reserved") await releaseClaimSources(supabase, claimSourceWallets, wallet);
      throw err;
    }

    if (result.status === "claimed") {
      return NextResponse.json({ eligible: true, held, walletHeld, claimed: true, code: result.code });
    }

    if (result.status === "sold_out") {
      if (reservation.status === "reserved") await releaseClaimSources(supabase, claimSourceWallets, wallet);
      return NextResponse.json({
        eligible: true, held, walletHeld, claimed: false, claimable: false, soldOut: true,
        message: "All codes have been claimed! Contact GVC for support.",
      });
    }

    // Race condition — release and ask user to retry
    if (reservation.status === "reserved") await releaseClaimSources(supabase, claimSourceWallets, wallet);
    return NextResponse.json(
      { error: "Another claim was processed simultaneously. Please try again." },
      { status: 409 }
    );
  } catch (err) {
    console.error("Claim error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
