import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

// HighKey Moments ERC-1155 on Manifold
export const HKM_CONTRACT = "0x74fcb6eb2a2d02207b36e804d800687ce78d210c" as const;
export const HKM_TOKEN_IDS = [1n, 2n, 3n] as const;

// delegate.xyz v2 registry
export const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493" as const;

// Delegation types in delegate.xyz v2
const DELEGATION_TYPE_ALL = 1;
const DELEGATION_TYPE_CONTRACT = 2;
const DELEGATION_TYPE_ERC1155 = 5;

// Badge image from GVC badge system
export const BADGE_IMAGE_URL =
  "https://sl1vlqqspml5zngx.public.blob.vercel-storage.com/badges/high-quality/highkeymoments_2_1771433773068_hq.webp";

// Minimal ERC-1155 ABI — only what we need
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

// delegate.xyz v2 ABI — getIncomingDelegations
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

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com"),
});

/**
 * Check if a wallet holds all 3 HighKey Moments tokens.
 * Returns { eligible, held } where held is [bool, bool, bool] for each token.
 */
export async function checkEligibility(walletAddress: string): Promise<{
  eligible: boolean;
  held: boolean[];
}> {
  const accounts = HKM_TOKEN_IDS.map(() => walletAddress as `0x${string}`);

  const balances = await publicClient.readContract({
    address: HKM_CONTRACT,
    abi: ERC1155_ABI,
    functionName: "balanceOfBatch",
    args: [accounts, [...HKM_TOKEN_IDS]],
  });

  const held = (balances as bigint[]).map((b) => b > 0n);
  const eligible = held.every(Boolean);

  return { eligible, held };
}

/**
 * Find vault addresses that have delegated to this wallet via delegate.xyz.
 * Filters for delegations relevant to the HKM contract (ALL, CONTRACT, or ERC1155).
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
      const contractAddr = d.contract_.toLowerCase();

      // Accept: full delegation, HKM contract delegation, or HKM ERC-1155 delegation
      if (
        type === DELEGATION_TYPE_ALL ||
        (type === DELEGATION_TYPE_CONTRACT && contractAddr === hkmLower) ||
        (type === DELEGATION_TYPE_ERC1155 && contractAddr === hkmLower)
      ) {
        vaults.add(d.from.toLowerCase());
      }
    }

    // Remove self if present
    vaults.delete(walletAddress.toLowerCase());

    return Array.from(vaults);
  } catch (err) {
    console.error("delegate.xyz lookup failed:", err);
    return [];
  }
}

/**
 * Check eligibility for a wallet including its delegate.xyz vaults.
 * Automatically discovers delegated vaults and checks their HKM holdings.
 */
export async function checkEligibilityWithDelegates(walletAddress: string): Promise<{
  eligible: boolean;
  held: boolean[];
  walletHeld: boolean[];
  delegateVaults: string[];
  perWallet: Record<string, boolean[]>;
}> {
  // Run delegate lookup and primary wallet check in parallel
  const [primaryResult, vaults] = await Promise.all([
    checkEligibility(walletAddress),
    getDelegatedVaults(walletAddress),
  ]);

  // If primary wallet is already eligible, no need to check vaults
  if (primaryResult.eligible || vaults.length === 0) {
    return {
      ...primaryResult,
      walletHeld: primaryResult.held,
      delegateVaults: vaults,
      perWallet: { [walletAddress.toLowerCase()]: primaryResult.held },
    };
  }

  // Check vaults for remaining tokens
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

/**
 * Check eligibility across multiple wallets.
 * Returns combined held (OR across all wallets) and per-wallet breakdown.
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

  // Build a single balanceOfBatch call for all wallets × all tokens
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
