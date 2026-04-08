# GVCPinClaimSite

## What to Build
A Claim site for free pin packs for Cosmic High Key moments badge holders

## Starting Point
This project uses the **A website or landing page** pattern. Here's what Claude should build first:

Build a landing page with: hero section with gold shimmer title, about section, features grid (3 columns), CTA section, footer with social links. Use the GVC brand system throughout.

## Selected Power-ups
- **Badge collection** -- 101 GVC badges with tiers and glow effects
- **NFT collection info** -- floor price, listings, metadata, and trait rarity for all 6,969 GVCs
- **Connect wallet button** -- let users connect their crypto wallet
- **Stats and charts** -- animated counters, data cards, dashboards
- **User accounts** -- sign up, log in, and protected pages
- **Sound and music** -- play sounds, background music, audio controls
- **Pop-up notifications** -- success, error, and info messages
- **NFT image loading** -- display NFT images with fallback handling
- **Blockchain lookups** -- check wallet balances and read smart contracts
- **Save and store data** -- persistent storage for scores, votes, and settings

## GVC Brand System

### Colors
- **Gold (primary):** #FFE048
- **Black (background):** #050505
- **Dark (cards/panels):** #121212
- **Gray (borders/subtle):** #1F1F1F
- **Pink accent:** #FF6B9D
- **Orange accent:** #FF5F1F
- **Green (success):** #2EFF2E

### Typography
- **Headlines:** Brice font (display), bold/black weight -- make them feel premium
- **Body text:** Mundial font, clean and readable, generous spacing
- CSS variables: `--font-brice` for display, `--font-mundial` for body
- Tailwind: `font-display` for headlines, `font-body` for text

### Design Language
- Dark-first design (#050505 background)
- Gold accents (#FFE048) for CTAs, highlights, important elements
- Gold shimmer effect on key headlines (`.text-shimmer` class)
- Gold glow on hover for cards (`.card-glow` class)
- Floating ember particles for ambient effect (`.ember` class)
- Rounded corners (12-16px), soft shadows
- Generous whitespace -- let things breathe
- Micro-animations on hover/interaction (scale, glow, fade)
- Use Framer Motion for entry animations

### CSS Utilities
- `.text-shimmer` -- animated gold gradient text
- `.card-glow` -- gold glow box shadow with hover enhancement
- `.ember` -- floating gold particle dot
- `.font-display` -- Brice headline font
- `.font-body` -- Mundial body font

## GVC API (no API key needed)
All GVC collection data is available from: https://api-hazel-pi-72.vercel.app/api
- GET /stats -- floor price, market cap, 24h volume, total sales, ETH price, VIBESTR price
- GET /sales?limit=10 -- recent GVC sales with price, image, timestamp
- GET /sales/history?limit=100 -- historical GVC sales (max 1000)
- GET /activity -- 30-day buys/sells, accumulator leaderboard
- GET /vibestr -- VIBESTR token data
- GET /vibestr/history -- daily VIBESTR price snapshots
- GET /market-depth -- bid/offer depth, floor price, lowest listing
- GET /traders -- 30-day trade stats
- GET /wallet/[address] -- ENS name, Twitter handle for a wallet
- GET /mentions -- recent X/Twitter mentions
Do NOT use the OpenSea API directly. Use the GVC API above instead.

## Contracts & Tokens (only use these)
- **GVC NFT:** 0xB8Ea78fcaCEf50d41375E44E6814ebbA36Bb33c4 (ERC-721, 6969 tokens)
- **HighKey Moments:** 0x74fcb6eb2a2d02207b36e804d800687ce78d210c (ERC-1155)
- **VIBESTR Token:** 0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196 (ERC-20, 18 decimals)
- **ETH** is the base currency for all GVC transactions
- ETH price: https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
- VIBESTR price: https://api.dexscreener.com/latest/dex/tokens/0xd0cC2b0eFb168bFe1f94a948D8df70FA10257196
- Public RPC: https://ethereum-rpc.publicnode.com
Do NOT reference any other NFT collections, tokens, or contracts. This project is only about GVC.

## Code Patterns

### Badge-Token Map

The project includes `badge_token_map.json` which maps every GVC NFT (by token ID) to its earned badges.
- `badgeToTokens`: badge ID -> array of qualifying token IDs
- `tokenToBadges`: token ID -> array of earned badge IDs
- 68 badges across all 6,969 tokens (21,856 assignments)

Use it to look up a holder's badges, build leaderboards, or filter the collection by badge.

```ts
import { getHolderBadges } from "@/lib/badge-helpers";

const map = await fetch('/badge_token_map.json').then(r => r.json());

// Get ALL badges for a holder (individual + combos + milestones + VIBESTR tier)
const result = getHolderBadges(["142", "572", "3933"], map, 150000);
// result.allBadges includes everything
// result.comboBadges e.g. ["gradient_hatrick"] if 3+ gradient tokens
// result.collectorBadges e.g. ["five_badges"] if 5+ unique badges
// result.vibestrTierBadge e.g. "vibestr_silver_tier"
```

### Badge Card with Tier Glow

```tsx
const TIER_COLORS: Record<string, string> = {
  bronze: "shadow-orange-400/30",
  silver: "shadow-gray-300/30",
  gold: "shadow-[#FFE048]/40",
  diamond: "shadow-cyan-300/50",
};

export function BadgeCard({ name, tier, image }: { name: string; tier: string; image: string }) {
  return (
    <div className={`rounded-2xl bg-[#121212] p-4 shadow-lg ${TIER_COLORS[tier] ?? ""} hover:scale-105 transition-transform`}>
      <img src={image} alt={name} className="w-full rounded-xl" />
      <p className="mt-2 font-display text-sm text-[#FFE048]">{name}</p>
      <span className="text-xs text-gray-400 capitalize">{tier}</span>
    </div>
  );
}
```

### Fetching GVC Collection Stats (no API key needed)

```ts
// Fetch live stats — floor price, volume, owners, market cap
const stats = await fetch("https://api-hazel-pi-72.vercel.app/api/stats").then(r => r.json());
// { floorPrice: 0.65, floorPriceUsd: 1625, numOwners: 1513, marketCapUsd: 9247054, volume24h: 2.1, totalSales: 11000 }

// Fetch recent sales
const sales = await fetch("https://api-hazel-pi-72.vercel.app/api/recent-sales?limit=10").then(r => r.json());
// [{ tokenId: "3101", priceEth: 0.611, buyer: "0x...", imageUrl: "...", timestamp: "..." }]

// Fetch top holders
const holders = await fetch("https://api-hazel-pi-72.vercel.app/api/holders?limit=20").then(r => r.json());
// { holders: [{ address: "0x...", tokenCount: 42, ens: "vibes.eth" }] }
```

All GVC data is available from \`https://api-hazel-pi-72.vercel.app/api\`. No API key needed. Data refreshes every 60 seconds.

### NFT Metadata & Trait Rarity

All 6,969 token traits are in \`public/gvc-metadata.json\`. Keyed by token ID (0-6968).

```ts
const metadata = await fetch('/gvc-metadata.json').then(r => r.json());

// Look up any token
const token = metadata["142"];
// token.name   -> "Citizen of Vibetown #142"
// token.traits -> { Type: "Robot", Face: "Laser Eyes", Hair: "Mohawk Gold", Body: "Hoodie Black", Background: "BG Mint" }
// token.image  -> "ipfs://QmY6J.../142.jpg"

// Calculate trait rarity
const allTokens = Object.values(metadata);
const traitCounts: Record<string, Record<string, number>> = {};
for (const t of allTokens) {
  for (const [type, value] of Object.entries(t.traits)) {
    traitCounts[type] = traitCounts[type] || {};
    traitCounts[type][value] = (traitCounts[type][value] || 0) + 1;
  }
}
// traitCounts["Type"]["Robot"] -> number of Robots in the collection
// Rarity % = count / 6969 * 100
```

Trait types: Type, Face, Hair, Body, Background. To display images, replace "ipfs://" with "https://ipfs.io/ipfs/".

### Web3 Wallet Connect
Use **RainbowKit** + **wagmi** for wallet connection. Install with:
```bash
npm install @rainbow-me/rainbowkit wagmi viem @tanstack/react-query
```
Follow the RainbowKit quickstart: https://www.rainbowkit.com/docs/installation

### Animated Stat Card Component

```tsx
"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

export function StatCard({ label, value, suffix = "" }: { label: string; value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = value / 40;
    const timer = setInterval(() => {
      start += step;
      if (start >= value) { setDisplay(value); clearInterval(timer); }
      else setDisplay(Math.floor(start));
    }, 25);
    return () => clearInterval(timer);
  }, [value]);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card-glow rounded-2xl bg-[#121212] p-6">
      <p className="font-body text-sm text-gray-400">{label}</p>
      <p className="font-display text-3xl text-[#FFE048]">{display.toLocaleString()}{suffix}</p>
    </motion.div>
  );
}
```

### Toast Notifications
Use **react-hot-toast** for feedback messages. Install with:
```bash
npm install react-hot-toast
```
Add `<Toaster position="bottom-center" />` in your layout, then call `toast.success("Saved!")` anywhere.

### NFT Image with IPFS Fallback

```tsx
export function NftImage({ tokenId, className }: { tokenId: number; className?: string }) {
  const gateways = [
    `https://ipfs.io/ipfs/`,
    `https://cloudflare-ipfs.com/ipfs/`,
    `https://gateway.pinata.cloud/ipfs/`,
  ];
  // Fetch metadata from OpenSea, extract image URL, try gateways in order
  // Replace ipfs:// prefix with gateway URL, use <img> with onError fallback
  return <img src={src} alt={`GVC #${tokenId}`} className={className} onError={handleFallback} />;
}
```

### On-Chain Reads (Wallet Balances)

```ts
import { createPublicClient, http, formatEther } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });

// Read ETH balance
const balance = await client.getBalance({ address: "0x..." });
console.log(formatEther(balance));
```

## Example Prompts to Try
- "Add a team member grid with photos and role titles"
- "Create a timeline section showing GVC milestones"
- "Add a newsletter signup form at the bottom"
- "Show the GVC floor price and total volume in the header"
- "Add a connect wallet button that shows my address and ETH balance"
- "Build an animated stats row with counters that tick up on load"
- "Display all 101 GVC badges in a grid with tier filtering"
- "Make everything responsive and look great on mobile"

## Token Metadata (`public/gvc-metadata.json`)

Complete metadata for all 6,969 GVC tokens. Keyed by token ID (0-6968).

```ts
const metadata = await fetch('/gvc-metadata.json').then(r => r.json());

const token = metadata["142"];
// token.name    -> "Citizen of Vibetown #142"
// token.traits  -> { Type: "Robot", Face: "Laser Eyes", Hair: "Mohawk Gold", Body: "Hoodie Black", Background: "BG Mint" }
// token.image   -> "ipfs://QmY6JpwTYx6zZHgfJb3gPJRh1U897NX4RudtK5jhJ3sNDS/142.jpg"

// Trait types: Type, Face, Hair, Body, Background
// To display image: replace "ipfs://" with "https://ipfs.io/ipfs/"
```

Use cases: rarity checker, token lookup, trait filtering, collection search, trait-based galleries.

## Assets
- Fonts: /public/fonts/ (Brice for headlines, Mundial for body)
- Shaka icon: /public/shaka.png
- GVC logotype: /public/gvc-logotype.svg
- Background grid: /public/grid.svg
- Token metadata: /public/gvc-metadata.json (all 6,969 tokens with traits + images)

## Tech Stack
- Next.js (App Router), React, TypeScript, Tailwind CSS, Framer Motion

## Important: Dev Server
The dev server is already running (the user started it before opening Claude Code). Do NOT run `npm run dev` — just edit the files and the browser will hot-reload automatically. If you need to install a new package, use `npm install <package>` and the dev server will pick it up.

## Project Structure
app/ -> Pages and layouts
components/ -> Reusable UI components
public/ -> Static assets
CLAUDE.md -> This file
README.md -> Human-readable docs
