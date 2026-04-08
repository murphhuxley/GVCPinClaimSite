/**
 * GVC Pin Claim — On-Chain Eligibility
 *
 * Reads ERC-1155 balances and delegate.xyz v2 delegations to determine
 * whether a wallet (or combination of wallets) holds all 3 HighKey Moments tokens.
 *
 * All reads use a public Ethereum RPC — no private keys involved.
 */

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// ─── Contract Addresses ──────────────────────────────────────────────

// HighKey Moments ERC-1155 (Manifold)
export const HKM_CONTRACT = "0x74fcb6eb2a2d02207b36e804d800687ce78d210c" as const;
export const HKM_TOKEN_IDS = [1n, 2n, 3n] as const;

// delegate.xyz v2 registry
export const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493" as const;

// Delegation types
const DELEGATION_TYPE_ALL = 1;       // full wallet delegation
const DELEGATION_TYPE_CONTRACT = 2;  // contract-level delegation
const DELEGATION_TYPE_ERC1155 = 5;   // token-type-level delegation

// ─── ABIs (minimal — only what we need) ──────────────────────────────

export const ERC1155_ABI = [
  {
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "ids", type: "uint256[]" },
    ],
    name: "balanceOfBatch",
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const DELEGATE_REGISTRY_ABI = [
  {
    inputs: [{ name: "to", type: "address" }],
    name: "getIncomingDelegations",
    outputs: [
      {
        components: [
          { name: "type_", type: "uint8" },
          { name: "to", type: "address" },
          { name: "from", type: "address" },
          { name: "rights", type: "bytes32" },
          { name: "contract_", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "amount", type: "uint256" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Client ──────────────────────────────────────────────────────────

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com"),
});

// ─── Single Wallet Check ─────────────────────────────────────────────

/**
 * Check if a single wallet holds all 3 HighKey Moments tokens.
 * Uses ERC-1155 balanceOfBatch for a single RPC call.
 */
export async function checkEligibility(walletAddress: string): Promise<{
  eligible: boolean;
  held: boolean[];  // [token1, token2, token3]
}> {
  const accounts = HKM_TOKEN_IDS.map(() => walletAddress as `0x${string}`);

  const balances = await publicClient.readContract({
    address: HKM_CONTRACT,
    abi: ERC1155_ABI,
    functionName: "balanceOfBatch",
    args: [accounts, [...HKM_TOKEN_IDS]],
  });

  const held = (balances as bigint[]).map((b) => b > 0n);
  return { eligible: held.every(Boolean), held };
}

// ─── Delegate.xyz Vault Discovery ────────────────────────────────────

/**
 * Find vault addresses that have delegated to this wallet via delegate.xyz v2.
 * Filters for delegations relevant to the HKM contract:
 *   - ALL (full wallet delegation)
 *   - CONTRACT (delegated the HKM contract specifically)
 *   - ERC1155 (delegated specific token types within HKM)
 */
export async function getDelegatedVaults(walletAddress: string): Promise<string[]> {
  try {
    const delegations = await publicClient.readContract({
      address: DELEGATE_REGISTRY,
      abi: DELEGATE_REGISTRY_ABI,
      functionName: "getIncomingDelegations",
      args: [walletAddress as `0x${string}`],
    });

    const hkmLower = HKM_CONTRACT.toLowerCase();
    const vaults = new Set<string>();

    for (const d of delegations) {
      const type = Number(d.type_);
      const contract = d.contract_.toLowerCase();

      if (
        type === DELEGATION_TYPE_ALL ||
        (type === DELEGATION_TYPE_CONTRACT && contract === hkmLower) ||
        (type === DELEGATION_TYPE_ERC1155 && contract === hkmLower)
      ) {
        vaults.add(d.from.toLowerCase());
      }
    }

    vaults.delete(walletAddress.toLowerCase()); // remove self
    return Array.from(vaults);
  } catch (err) {
    console.error("delegate.xyz lookup failed:", err);
    return [];
  }
}

// ─── Combined Check (Wallet + Delegates) ─────────────────────────────

/**
 * Check eligibility including delegate.xyz vaults.
 * 1. Check primary wallet + discover delegates in parallel
 * 2. If primary is already eligible, skip vault checks
 * 3. Otherwise, check all wallets together with a single RPC call
 */
export async function checkEligibilityWithDelegates(walletAddress: string): Promise<{
  eligible: boolean;
  held: boolean[];           // combined across all wallets
  walletHeld: boolean[];     // primary wallet only
  delegateVaults: string[];  // discovered vault addresses
  perWallet: Record<string, boolean[]>;
}> {
  const [primaryResult, vaults] = await Promise.all([
    checkEligibility(walletAddress),
    getDelegatedVaults(walletAddress),
  ]);

  if (primaryResult.eligible || vaults.length === 0) {
    return {
      ...primaryResult,
      walletHeld: primaryResult.held,
      delegateVaults: vaults,
      perWallet: { [walletAddress.toLowerCase()]: primaryResult.held },
    };
  }

  const allAddresses = [walletAddress, ...vaults];
  const multiResult = await checkMultiWalletEligibility(allAddresses);

  return {
    eligible: multiResult.eligible,
    held: multiResult.held,
    walletHeld: multiResult.perWallet[walletAddress.toLowerCase()] || primaryResult.held,
    delegateVaults: vaults,
    perWallet: multiResult.perWallet,
  };
}

// ─── Multi-Wallet Check ──────────────────────────────────────────────

/**
 * Check eligibility across multiple wallets in a single RPC call.
 * Builds one balanceOfBatch call for all wallets × all tokens.
 * Returns combined eligibility (OR across wallets) and per-wallet breakdown.
 */
export async function checkMultiWalletEligibility(walletAddresses: string[]): Promise<{
  eligible: boolean;
  held: boolean[];
  perWallet: Record<string, boolean[]>;
}> {
  if (walletAddresses.length === 0) {
    return { eligible: false, held: [false, false, false], perWallet: {} };
  }

  if (walletAddresses.length === 1) {
    const result = await checkEligibility(walletAddresses[0]);
    return { ...result, perWallet: { [walletAddresses[0].toLowerCase()]: result.held } };
  }

  // Single RPC call: N wallets × 3 tokens
  const accounts: `0x${string}`[] = [];
  const ids: bigint[] = [];
  for (const wallet of walletAddresses) {
    for (const tokenId of HKM_TOKEN_IDS) {
      accounts.push(wallet as `0x${string}`);
      ids.push(tokenId);
    }
  }

  const balances = await publicClient.readContract({
    address: HKM_CONTRACT,
    abi: ERC1155_ABI,
    functionName: "balanceOfBatch",
    args: [accounts, ids],
  });

  const balanceArr = balances as bigint[];
  const perWallet: Record<string, boolean[]> = {};
  const combined = [false, false, false];

  for (let w = 0; w < walletAddresses.length; w++) {
    const walletHeld = HKM_TOKEN_IDS.map((_, t) => balanceArr[w * 3 + t] > 0n);
    perWallet[walletAddresses[w].toLowerCase()] = walletHeld;
    walletHeld.forEach((h, t) => { if (h) combined[t] = true; });
  }

  return { eligible: combined.every(Boolean), held: combined, perWallet };
}
