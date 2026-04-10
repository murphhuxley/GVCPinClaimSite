import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAddress, isAddress, verifyMessage } from "viem";
import { checkEligibility, checkMultiWalletEligibility, checkEligibilityWithDelegates } from "@/lib/contracts";

type ClaimIntent = "challenge" | "check" | "claim";
type SupabaseAdminClient = SupabaseClient<any, "public", any>;
type SingleWalletEligibility = Awaited<ReturnType<typeof checkEligibility>>;
type MultiWalletEligibility = Awaited<ReturnType<typeof checkMultiWalletEligibility>>;
type ExistingClaimRow = { discount_code: string };
type AvailableCodeRow = { id: number; discount_code: string };
type ClaimedWalletRow = { wallet_address: string };
type ClaimSourceRow = { source_wallet: string; claimed_by_wallet: string };
type ClaimChallenge = {
  address: string;
  claimant: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};
type ClaimProofPayload = {
  challenge: string;
  proof: string;
  signature: string;
};
type DelegateProofPayload = ClaimProofPayload & {
  address: string;
};
type RateLimitBucket = { count: number; resetAt: number };

declare global {
  var __gvcClaimRateLimits: Map<string, RateLimitBucket> | undefined;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS: Record<ClaimIntent | "check", { perIp: number; perWallet: number }> = {
  challenge: { perIp: 24, perWallet: 12 },
  check: { perIp: 90, perWallet: 30 },
  claim: { perIp: 18, perWallet: 6 },
};

function getSupabaseAdmin(): SupabaseAdminClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    return null;
  }

  return createClient<any>(url, serviceKey);
}

function getRateLimitStore(): Map<string, RateLimitBucket> {
  if (!globalThis.__gvcClaimRateLimits) {
    globalThis.__gvcClaimRateLimits = new Map();
  }

  return globalThis.__gvcClaimRateLimits;
}

function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const store = getRateLimitStore();
  const currentBucket = store.get(key);

  if (!currentBucket || currentBucket.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (currentBucket.count >= limit) {
    return false;
  }

  currentBucket.count += 1;
  store.set(key, currentBucket);
  return true;
}

function consumeRateLimit(req: NextRequest, intent: ClaimIntent | "check", wallet: string): boolean {
  const clientIp = getClientIp(req);
  const limits = RATE_LIMITS[intent];

  return (
    checkRateLimit(`ip:${intent}:${clientIp}`, limits.perIp) &&
    checkRateLimit(`wallet:${intent}:${wallet}`, limits.perWallet)
  );
}

function getClaimAuthSecret(): string | null {
  return process.env.CLAIM_AUTH_SECRET || process.env.SUPABASE_SERVICE_KEY || null;
}

function encodeChallenge(challenge: ClaimChallenge): string {
  return Buffer.from(JSON.stringify(challenge)).toString("base64url");
}

function decodeChallenge(serializedChallenge: string): ClaimChallenge | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(serializedChallenge, "base64url").toString("utf8")
    ) as Partial<ClaimChallenge>;

    if (
      typeof parsed.address !== "string" ||
      typeof parsed.claimant !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }

    return {
      address: parsed.address,
      claimant: parsed.claimant,
      nonce: parsed.nonce,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function signChallenge(serializedChallenge: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(serializedChallenge)
    .digest("base64url");
}

function proofsMatch(expectedProof: string, providedProof: string): boolean {
  const expected = Buffer.from(expectedProof);
  const provided = Buffer.from(providedProof);

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
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

function createClaimChallenge(address: string, claimant: string = address): {
  challenge: string;
  proof: string;
  signingMessage: string;
  expiresAt: string;
} | null {
  const secret = getClaimAuthSecret();

  if (!secret) {
    return null;
  }

  const payload: ClaimChallenge = {
    address,
    claimant,
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    // Multi-wallet flows involve disconnecting and reconnecting several wallets.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const serializedChallenge = encodeChallenge(payload);

  return {
    challenge: serializedChallenge,
    proof: signChallenge(serializedChallenge, secret),
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

  if (!secret) {
    return false;
  }

  const decodedChallenge = decodeChallenge(payload.challenge);
  if (!decodedChallenge) {
    return false;
  }

  if (decodedChallenge.address !== wallet || decodedChallenge.claimant !== claimant) {
    return false;
  }

  const expiresAt = Date.parse(decodedChallenge.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return false;
  }

  const expectedProof = signChallenge(payload.challenge, secret);
  if (!proofsMatch(expectedProof, payload.proof)) {
    return false;
  }

  try {
    return await verifyMessage({
      address: getAddress(wallet),
      message: buildClaimSigningMessage(decodedChallenge),
      signature: payload.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

async function getVerifiedDelegateAddresses(
  primaryWallet: string,
  rawDelegates: unknown
): Promise<string[]> {
  if (!Array.isArray(rawDelegates)) {
    return [];
  }

  const verifiedDelegates: string[] = [];

  for (const rawDelegate of rawDelegates.slice(0, 9)) {
    if (!rawDelegate || typeof rawDelegate !== "object") {
      continue;
    }

    const delegate = rawDelegate as Partial<DelegateProofPayload>;

    if (typeof delegate.address !== "string" || !isAddress(delegate.address)) {
      continue;
    }

    const normalizedDelegate = getAddress(delegate.address).toLowerCase();
    if (
      normalizedDelegate === primaryWallet ||
      verifiedDelegates.includes(normalizedDelegate) ||
      typeof delegate.challenge !== "string" ||
      typeof delegate.proof !== "string" ||
      typeof delegate.signature !== "string"
    ) {
      continue;
    }

    const isValidDelegate = await verifyClaimProof(normalizedDelegate, {
      challenge: delegate.challenge,
      proof: delegate.proof,
      signature: delegate.signature,
    }, primaryWallet);

    if (isValidDelegate) {
      verifiedDelegates.push(normalizedDelegate);
    }
  }

  return verifiedDelegates;
}

async function getExistingClaim(
  supabase: SupabaseAdminClient,
  wallet: string
): Promise<ExistingClaimRow | null> {
  const { data, error } = await supabase
    .from("claims")
    .select("discount_code")
    .eq("wallet_address", wallet)
    .maybeSingle<ExistingClaimRow>();

  if (error) {
    throw error;
  }

  return data;
}

async function getClaimedWallets(
  supabase: SupabaseAdminClient,
  wallets: string[]
): Promise<string[]> {
  if (wallets.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("claims")
    .select("wallet_address")
    .in("wallet_address", wallets)
    .not("wallet_address", "is", null);

  if (error) {
    throw error;
  }

  return (data as ClaimedWalletRow[] | null)?.map(({ wallet_address }) => wallet_address) || [];
}

async function getNextAvailableCode(
  supabase: SupabaseAdminClient
): Promise<AvailableCodeRow | null> {
  const { data, error } = await supabase
    .from("claims")
    .select("id, discount_code")
    .is("wallet_address", null)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle<AvailableCodeRow>();

  if (error) {
    throw error;
  }

  return data;
}

async function assignDiscountCode(
  supabase: SupabaseAdminClient,
  wallet: string
): Promise<
  | { status: "claimed"; code: string }
  | { status: "sold_out" }
  | { status: "retry" }
> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const availableCode = await getNextAvailableCode(supabase);

    if (!availableCode) {
      return { status: "sold_out" };
    }

    const { data, error } = await supabase
      .from("claims")
      .update({
        wallet_address: wallet,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", availableCode.id)
      .is("wallet_address", null)
      .select("discount_code")
      .maybeSingle<ExistingClaimRow>();

    if (error) {
      throw error;
    }

    if (data?.discount_code) {
      return { status: "claimed", code: data.discount_code };
    }

    const existingClaim = await getExistingClaim(supabase, wallet);
    if (existingClaim?.discount_code) {
      return { status: "claimed", code: existingClaim.discount_code };
    }
  }

  const existingClaim = await getExistingClaim(supabase, wallet);
  if (existingClaim?.discount_code) {
    return { status: "claimed", code: existingClaim.discount_code };
  }

  const nextAvailableCode = await getNextAvailableCode(supabase);
  return nextAvailableCode ? { status: "retry" } : { status: "sold_out" };
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message.includes(relationName) && message.toLowerCase().includes("does not exist");
}

function getClaimSourceWallets(
  primaryWallet: string,
  perWallet: Record<string, boolean[]>
): string[] {
  const availableWallets = Object.entries(perWallet).filter(([, held]) => held.some(Boolean));

  if (availableWallets.length === 0) {
    return [primaryWallet];
  }

  const orderedWallets = availableWallets.sort(([walletA, heldA], [walletB, heldB]) => {
    if (walletA === primaryWallet) return -1;
    if (walletB === primaryWallet) return 1;
    return heldB.filter(Boolean).length - heldA.filter(Boolean).length;
  });

  const selected = new Set<string>();
  const covered = [false, false, false];

  while (!covered.every(Boolean)) {
    let bestWallet: string | null = null;
    let bestCoverage = 0;

    for (const [wallet, held] of orderedWallets) {
      if (selected.has(wallet)) {
        continue;
      }

      const uncoveredCount = held.reduce(
        (count, hasToken, index) => count + (hasToken && !covered[index] ? 1 : 0),
        0
      );

      if (uncoveredCount > bestCoverage) {
        bestCoverage = uncoveredCount;
        bestWallet = wallet;
      }
    }

    if (!bestWallet || bestCoverage === 0) {
      break;
    }

    selected.add(bestWallet);
    const held = perWallet[bestWallet] || [false, false, false];
    held.forEach((hasToken, index) => {
      if (hasToken) {
        covered[index] = true;
      }
    });
  }

  if (!covered.every(Boolean)) {
    return [primaryWallet];
  }

  return Array.from(selected);
}

async function getClaimSourceReservations(
  supabase: SupabaseAdminClient,
  sourceWallets: string[]
): Promise<ClaimSourceRow[] | null> {
  if (sourceWallets.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("claim_sources")
    .select("source_wallet, claimed_by_wallet")
    .in("source_wallet", sourceWallets);

  if (error) {
    if (isMissingRelationError(error, "claim_sources")) {
      return null;
    }

    throw error;
  }

  return (data as ClaimSourceRow[] | null) || [];
}

async function reserveClaimSources(
  supabase: SupabaseAdminClient,
  sourceWallets: string[],
  claimantWallet: string
): Promise<
  | { status: "reserved" }
  | { status: "conflict"; sourceWallet: string }
  | { status: "unavailable" }
> {
  if (sourceWallets.length === 0) {
    return { status: "reserved" };
  }

  const existingReservations = await getClaimSourceReservations(supabase, sourceWallets);
  if (existingReservations === null) {
    return { status: "unavailable" };
  }

  const conflictingReservation = existingReservations.find(
    ({ claimed_by_wallet }) => claimed_by_wallet !== claimantWallet
  );

  if (conflictingReservation) {
    return { status: "conflict", sourceWallet: conflictingReservation.source_wallet };
  }

  const reservedWallets = new Set(existingReservations.map(({ source_wallet }) => source_wallet));
  const walletsToInsert = sourceWallets.filter((wallet) => !reservedWallets.has(wallet));

  if (walletsToInsert.length === 0) {
    return { status: "reserved" };
  }

  const { error } = await supabase.from("claim_sources").insert(
    walletsToInsert.map((sourceWallet) => ({
      source_wallet: sourceWallet,
      claimed_by_wallet: claimantWallet,
      claimed_at: new Date().toISOString(),
    }))
  );

  if (!error) {
    return { status: "reserved" };
  }

  if (isMissingRelationError(error, "claim_sources")) {
    return { status: "unavailable" };
  }

  const afterInsertReservations = await getClaimSourceReservations(supabase, sourceWallets);
  if (afterInsertReservations === null) {
    return { status: "unavailable" };
  }

  const postInsertConflict = afterInsertReservations.find(
    ({ claimed_by_wallet }) => claimed_by_wallet !== claimantWallet
  );

  if (postInsertConflict) {
    return { status: "conflict", sourceWallet: postInsertConflict.source_wallet };
  }

  throw error;
}

async function releaseClaimSources(
  supabase: SupabaseAdminClient,
  sourceWallets: string[],
  claimantWallet: string
): Promise<void> {
  if (sourceWallets.length === 0) {
    return;
  }

  const existingReservations = await getClaimSourceReservations(supabase, sourceWallets);
  if (existingReservations === null) {
    return;
  }

  const ownedWallets = existingReservations
    .filter(({ claimed_by_wallet }) => claimed_by_wallet === claimantWallet)
    .map(({ source_wallet }) => source_wallet);

  if (ownedWallets.length === 0) {
    return;
  }

  const { error } = await supabase
    .from("claim_sources")
    .delete()
    .eq("claimed_by_wallet", claimantWallet)
    .in("source_wallet", ownedWallets);

  if (error && !isMissingRelationError(error, "claim_sources")) {
    throw error;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const address = typeof body?.address === "string" ? body.address : "";
    const claimantAddress =
      typeof body?.claimantAddress === "string" ? body.claimantAddress : address;
    const intent: ClaimIntent =
      body?.intent === "claim" || body?.intent === "challenge"
        ? body.intent
        : "check";

    if (!isAddress(address)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    if (!isAddress(claimantAddress)) {
      return NextResponse.json({ error: "Invalid claim wallet address" }, { status: 400 });
    }

    const normalizedAddress = getAddress(address);
    const normalizedClaimantAddress = getAddress(claimantAddress);
    const wallet = normalizedAddress.toLowerCase();
    const claimantWallet = normalizedClaimantAddress.toLowerCase();

    if (!consumeRateLimit(req, intent, wallet)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute and try again." },
        { status: 429 }
      );
    }

    if (intent === "challenge") {
      const challengePayload = createClaimChallenge(wallet, claimantWallet);

      if (!challengePayload) {
        return NextResponse.json(
          { error: "Claim signing is not configured on the server." },
          { status: 500 }
        );
      }

      return NextResponse.json(challengePayload);
    }

    const supabase = getSupabaseAdmin();

    if (intent === "claim") {
      const signature = typeof body?.signature === "string" ? body.signature : "";
      const challenge = typeof body?.challenge === "string" ? body.challenge : "";
      const proof = typeof body?.proof === "string" ? body.proof : "";
      const isValidProof = await verifyClaimProof(wallet, { signature, challenge, proof }, wallet);

      if (!isValidProof) {
        return NextResponse.json(
          { error: "Wallet signature verification failed. Please try again." },
          { status: 401 }
        );
      }

      if (supabase) {
        const existingClaim = await getExistingClaim(supabase, wallet);

        if (existingClaim?.discount_code) {
          return NextResponse.json({
            eligible: true,
            held: [false, false, false],
            walletHeld: [false, false, false],
            claimed: true,
            code: existingClaim.discount_code,
          });
        }
      }
    }

    const verifiedDelegateAddresses = await getVerifiedDelegateAddresses(wallet, body?.delegateProofs);

    // 1. Check on-chain eligibility (server-side — don't trust the client)
    // Also auto-check delegate.xyz vaults for the primary wallet
    const delegateResult = await checkEligibilityWithDelegates(normalizedAddress);

    // Merge delegate.xyz vaults with manually-proven delegate wallets
    const allManualDelegates = verifiedDelegateAddresses.filter(
      addr => !delegateResult.delegateVaults.includes(addr) && addr !== wallet
    );

    let eligible: boolean;
    let held: boolean[];
    let walletHeld: boolean[];
    let perWallet: Record<string, boolean[]>;

    if (delegateResult.eligible) {
      // delegate.xyz vaults were enough
      eligible = true;
      held = delegateResult.held;
      walletHeld = delegateResult.walletHeld;
      perWallet = delegateResult.perWallet;
    } else if (allManualDelegates.length > 0) {
      // Combine delegate.xyz results with manually-proven wallets
      const allAddresses = [
        wallet,
        ...delegateResult.delegateVaults,
        ...allManualDelegates,
      ];
      const combined = await checkMultiWalletEligibility(allAddresses);
      eligible = combined.eligible;
      held = combined.held;
      walletHeld = combined.perWallet[wallet] || delegateResult.walletHeld;
      perWallet = combined.perWallet;
    } else {
      eligible = delegateResult.eligible;
      held = delegateResult.held;
      walletHeld = delegateResult.walletHeld;
      perWallet = delegateResult.perWallet;
    }

    const delegateVaults = delegateResult.delegateVaults;
    const claimSourceWallets = eligible ? getClaimSourceWallets(wallet, perWallet) : [];
    const requiresDelegatedSources = claimSourceWallets.some((sourceWallet) => sourceWallet !== wallet);

    if (!eligible) {
      return NextResponse.json({
        eligible: false,
        held,
        walletHeld,
        delegateVaults,
        message: "You need all 3 HighKey Moments tokens to claim",
      });
    }

    // 2. Check if Supabase is configured
    if (!supabase) {
      return NextResponse.json({
        eligible: true,
        held,
        walletHeld,
        delegateVaults,
        claimed: false,
        claimable: false,
        soldOut: false,
        message: "Eligible! Discount codes not yet loaded — check back soon.",
      });
    }

    // 3. Auto-check stops here. Claim/reveal requires a signed wallet proof.
    if (intent === "check") {
      const availableCode = await getNextAvailableCode(supabase);
      return NextResponse.json({
        eligible: true,
        held,
        walletHeld,
        claimed: false,
        claimable: true,
        soldOut: !availableCode,
        message: availableCode
          ? "You're eligible to claim your free pin pack. Sign with your wallet to continue."
          : "New claims are sold out. If this wallet already claimed a code, sign to view it again.",
      });
    }

    // 4. Return an existing code or claim a new one after wallet ownership is verified.
    const existingClaim = await getExistingClaim(supabase, wallet);
    if (existingClaim?.discount_code) {
      return NextResponse.json({
        eligible: true,
        held,
        walletHeld,
        claimed: true,
        code: existingClaim.discount_code,
      });
    }

    const alreadyClaimedSourceWallets = await getClaimedWallets(
      supabase,
      claimSourceWallets.filter((sourceWallet) => sourceWallet !== wallet)
    );

    if (alreadyClaimedSourceWallets.length > 0) {
      return NextResponse.json(
        {
          error:
            "One of the wallets used for this claim has already been used to claim a pin pack.",
        },
        { status: 409 }
      );
    }

    const sourceReservation = await reserveClaimSources(supabase, claimSourceWallets, wallet);

    if (sourceReservation.status === "conflict") {
      return NextResponse.json(
        {
          error:
            "One of the wallets used for this claim has already been used to claim from another wallet.",
        },
        { status: 409 }
      );
    }

    if (sourceReservation.status === "unavailable") {
      if (requiresDelegatedSources) {
        return NextResponse.json(
          {
            error:
              "Delegate claim protection is not available right now. Please contact support before retrying.",
          },
          { status: 503 }
        );
      }

      console.warn("claim_sources table is missing; delegated-wallet claim locks are disabled");
    }

    // 5. Claim the next available code with retries for concurrent requests.
    let claimResult: Awaited<ReturnType<typeof assignDiscountCode>>;

    try {
      claimResult = await assignDiscountCode(supabase, wallet);
    } catch (error) {
      if (sourceReservation.status === "reserved") {
        await releaseClaimSources(supabase, claimSourceWallets, wallet);
      }

      throw error;
    }

    if (claimResult.status === "claimed") {
      return NextResponse.json({
        eligible: true,
        held,
        walletHeld,
        claimed: true,
        code: claimResult.code,
      });
    }

    if (claimResult.status === "sold_out") {
      if (sourceReservation.status === "reserved") {
        await releaseClaimSources(supabase, claimSourceWallets, wallet);
      }

      return NextResponse.json({
        eligible: true,
        held,
        walletHeld,
        claimed: false,
        claimable: false,
        soldOut: true,
        message: "All codes have been claimed! Contact GVC for support.",
      });
    }

    if (sourceReservation.status === "reserved") {
      await releaseClaimSources(supabase, claimSourceWallets, wallet);
    }

    return NextResponse.json(
      { error: "Another claim was processed at the same time. Please try again." },
      { status: 409 }
    );
  } catch (err) {
    console.error("Claim error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
