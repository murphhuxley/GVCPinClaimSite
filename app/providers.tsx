"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WALLETCONNECT_ID ||
  "placeholder";

const config = getDefaultConfig({
  appName: "GVC Pin Claim",
  projectId: walletConnectProjectId,
  chains: [mainnet],
  transports: {
    [mainnet.id]: http("https://ethereum-rpc.publicnode.com"),
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
