import { mainnet } from "viem/chains";

export const DEFAULT_MAINNET_RPC_URLS = Array.from(
  new Set([
    "https://ethereum-rpc.publicnode.com",
    ...mainnet.rpcUrls.default.http,
  ])
);

export function parseRpcUrlList(rawValue: string | undefined | null): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[\n,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function resolveRpcUrls(
  preferredUrls: string[],
  fallbackUrls: string[] = DEFAULT_MAINNET_RPC_URLS
): string[] {
  return Array.from(new Set([...preferredUrls, ...fallbackUrls]));
}
