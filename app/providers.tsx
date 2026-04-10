"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider, fallback, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { parseRpcUrlList, resolveRpcUrls } from "@/lib/rpc";
import "@rainbow-me/rainbowkit/styles.css";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WALLETCONNECT_ID ||
  "placeholder";
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://gvc-pin-claim.vercel.app";
const clientRpcUrls = resolveRpcUrls([
  ...parseRpcUrlList(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URLS),
  ...parseRpcUrlList(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
]);

const config = getDefaultConfig({
  appName: "GVC Pin Claim",
  appDescription: "Claim your Good Vibes Club HighKey Moments pin pack.",
  appUrl,
  appIcon: `${appUrl}/shaka.png`,
  projectId: walletConnectProjectId,
  chains: [mainnet],
  transports: {
    [mainnet.id]: fallback(clientRpcUrls.map((url) => http(url)), { rank: false }),
  },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#FFE048",
            accentColorForeground: "#050505",
            borderRadius: "large",
            fontStack: "system",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
