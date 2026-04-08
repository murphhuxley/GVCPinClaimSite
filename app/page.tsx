"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import Image from "next/image";
import confetti from "canvas-confetti";
import toast from "react-hot-toast";
import { BADGE_IMAGE_URL } from "@/lib/contracts";

type ClaimState =
  | { step: "connect" }
  | { step: "checking" }
  | { step: "not_eligible"; held: boolean[] }
  | { step: "eligible"; held: boolean[]; claimable: boolean; soldOut: boolean; message?: string }
  | { step: "claiming" }
  | { step: "claimed"; code: string }
  | { step: "error"; message: string };

type ClaimResponse = {
  eligible?: boolean;
  held?: boolean[];
  walletHeld?: boolean[];
  claimed?: boolean;
  claimable?: boolean;
  soldOut?: boolean;
  code?: string;
  message?: string;
  error?: string;
};

type ChallengeResponse = {
  challenge?: string;
  proof?: string;
  signingMessage?: string;
  expiresAt?: string;
  error?: string;
};

type WalletProof = {
  address: string;
  claimantAddress: string;
  challenge: string;
  proof: string;
  signature: string;
  expiresAt?: string;
};

const TOKEN_NAMES = ["HighKey Moments I", "HighKey Moments II", "HighKey Moments III"];

const SHOPIFY_URL = "https://shop.goodvibesclub.io/products/spring-vibes-pin-pack";

function fireConfetti() {
  const duration = 2000;
  const end = Date.now() + duration;

  const frame = () => {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.7 },
      colors: ["#FFE048", "#fff8b8", "#FF6B9D", "#2EFF2E"],
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.7 },
      colors: ["#FFE048", "#fff8b8", "#FF6B9D", "#2EFF2E"],
    });

    if (Date.now() < end) requestAnimationFrame(frame);
  };
  frame();
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<ClaimState>({ step: "connect" });
  const activeWalletRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const wasConnectedRef = useRef(false);

  // Multi-wallet: track one primary claim wallet plus linked delegate wallets.
  const [primaryWallet, setPrimaryWallet] = useState<string | null>(null);
  const primaryWalletRef = useRef<string | null>(null);
  const [walletProofs, setWalletProofs] = useState<Record<string, WalletProof>>({});
  const walletProofsRef = useRef<Record<string, WalletProof>>({});
  const [addingWallet, setAddingWallet] = useState(false);
  const [linkingWallet, setLinkingWallet] = useState(false);

  // Keep ref in sync with state
  useEffect(() => { walletProofsRef.current = walletProofs; }, [walletProofs]);
  useEffect(() => { primaryWalletRef.current = primaryWallet; }, [primaryWallet]);

  useEffect(() => {
    activeWalletRef.current = isConnected && address ? address.toLowerCase() : null;
    requestIdRef.current += 1;
  }, [isConnected, address]);

  const beginRequest = useCallback((walletAddress: string) => {
    const normalizedWallet = walletAddress.toLowerCase();

    activeWalletRef.current = normalizedWallet;
    const requestId = ++requestIdRef.current;

    return { normalizedWallet, requestId };
  }, []);

  const isRequestCurrent = useCallback(
    (walletAddress: string, requestId: number) =>
      activeWalletRef.current === walletAddress.toLowerCase() &&
      requestIdRef.current === requestId,
    []
  );

  const applyClaimResponse = useCallback(
    (data: ClaimResponse, options?: { celebrate?: boolean }) => {
      if (!data.eligible) {
        setState({ step: "not_eligible", held: data.held || [false, false, false] });
        return;
      }

      if (data.claimed && data.code) {
        setState({ step: "claimed", code: data.code });

        if (options?.celebrate) {
          fireConfetti();
        }
        return;
      }

      setState({
        step: "eligible",
        held: data.held || [true, true, true],
        claimable: Boolean(data.claimable),
        soldOut: Boolean(data.soldOut),
        message: data.message,
      });
    },
    []
  );

  const resetLinkedWalletSession = useCallback((nextPrimaryWallet: string | null = null) => {
    walletProofsRef.current = {};
    setWalletProofs({});
    setPrimaryWallet(nextPrimaryWallet);
    setAddingWallet(false);
    setLinkingWallet(false);
  }, []);

  const handleDisconnect = useCallback(() => {
    resetLinkedWalletSession();
    disconnect();
  }, [disconnect, resetLinkedWalletSession]);

  const isWalletProofActive = useCallback((walletProof: WalletProof) => {
    if (!walletProof.expiresAt) {
      return true;
    }

    const expiresAt = Date.parse(walletProof.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }, []);

  const getDelegateProofs = useCallback(
    (currentWallet: string, proofs: Record<string, WalletProof>, claimantWallet: string | null) => {
      const normalizedWallet = currentWallet.toLowerCase();
      const normalizedClaimant = claimantWallet?.toLowerCase();

      return Object.values(proofs).filter(
        (walletProof) =>
          isWalletProofActive(walletProof) &&
          walletProof.address !== normalizedWallet &&
          walletProof.claimantAddress === normalizedClaimant
      );
    },
    [isWalletProofActive]
  );

  const requestWalletProof = useCallback(async (
    walletAddress: string,
    claimantAddress: string = walletAddress
  ): Promise<WalletProof> => {
    const challengeRes = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: walletAddress,
        claimantAddress,
        intent: "challenge",
      }),
    });

    const challengeData = (await challengeRes.json()) as ChallengeResponse;

    if (
      !challengeRes.ok ||
      !challengeData.challenge ||
      !challengeData.proof ||
      !challengeData.signingMessage
    ) {
      throw new Error(challengeData.error || "Couldn't start wallet verification.");
    }

    const signature = await signMessageAsync({
      message: challengeData.signingMessage,
    });

    return {
      address: walletAddress.toLowerCase(),
      claimantAddress: claimantAddress.toLowerCase(),
      challenge: challengeData.challenge,
      proof: challengeData.proof,
      signature,
      expiresAt: challengeData.expiresAt,
    };
  }, [signMessageAsync]);

  const handleAddWallet = useCallback(async () => {
    if (!address) {
      return;
    }

    setPrimaryWallet(address.toLowerCase());
    setAddingWallet(true);
    disconnect();
  }, [address, disconnect]);

  const linkConnectedWallet = useCallback(async (walletAddress: string, claimantWallet: string) => {
    const { normalizedWallet, requestId } = beginRequest(walletAddress);
    setLinkingWallet(true);
    setState({ step: "checking" });

    try {
      const walletProof = await requestWalletProof(walletAddress, claimantWallet);

      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      setWalletProofs(prev => ({ ...prev, [walletProof.address]: walletProof }));
      toast.success("Wallet linked. Connect another wallet, or reconnect your main wallet to finish.");
      disconnect();
    } catch (error) {
      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      const message =
        error instanceof Error &&
        (error.message.toLowerCase().includes("user rejected") ||
          error.message.toLowerCase().includes("user denied"))
          ? "Wallet signature was cancelled."
          : error instanceof Error && error.message
            ? error.message
            : "Couldn't link this wallet. Please try again.";

      toast.error(message);
      disconnect();
    } finally {
      setLinkingWallet(false);
    }
  }, [beginRequest, disconnect, isRequestCurrent, requestWalletProof]);

  const loadClaimStatus = useCallback(async (walletAddress: string) => {
    const { normalizedWallet, requestId } = beginRequest(walletAddress);
    setState({ step: "checking" });

    const delegateProofs = getDelegateProofs(
      walletAddress,
      walletProofsRef.current,
      primaryWalletRef.current || walletAddress
    );

    try {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: walletAddress,
          intent: "check",
          delegateProofs: delegateProofs.length > 0 ? delegateProofs : undefined,
        }),
      });

      const data = (await res.json()) as ClaimResponse;

      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      if (!res.ok) {
        setState({
          step: "error",
          message: data.error || data.message || "Something went wrong. Please try again.",
        });
        return;
      }

      applyClaimResponse(data);
      setAddingWallet(false);
    } catch {
      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      setState({ step: "error", message: "Something went wrong. Please try again." });
    }
  }, [applyClaimResponse, beginRequest, getDelegateProofs, isRequestCurrent]);

  // Auto-check when wallet connects
  useEffect(() => {
    if (!isConnected || !address) {
      if (wasConnectedRef.current && !addingWallet) {
        resetLinkedWalletSession();
      }

      wasConnectedRef.current = false;
      setState({ step: "connect" });
      return;
    }

    wasConnectedRef.current = true;
    const normalizedWallet = address.toLowerCase();
    const currentPrimaryWallet = primaryWalletRef.current;

    if (addingWallet && currentPrimaryWallet) {
      if (normalizedWallet === currentPrimaryWallet) {
        setAddingWallet(false);
        void loadClaimStatus(address);
        return;
      }

      if (!linkingWallet) {
        void linkConnectedWallet(address, currentPrimaryWallet);
      }
      return;
    }

    if (!currentPrimaryWallet) {
      setPrimaryWallet(normalizedWallet);
      void loadClaimStatus(address);
      return;
    }

    if (normalizedWallet !== currentPrimaryWallet) {
      resetLinkedWalletSession(normalizedWallet);
      void loadClaimStatus(address);
      return;
    }

    void loadClaimStatus(address);
  }, [addingWallet, address, isConnected, linkConnectedWallet, linkingWallet, loadClaimStatus, resetLinkedWalletSession]);

  const linkedWalletCount = primaryWallet
    ? Object.values(walletProofs).filter(
        (walletProof) =>
          isWalletProofActive(walletProof) &&
          walletProof.claimantAddress === primaryWallet &&
          walletProof.address !== primaryWallet
      ).length
    : 0;
  const checkedWalletCount = primaryWallet ? 1 + linkedWalletCount : 0;

  const handleClaim = async () => {
    if (!address) return;
    const { normalizedWallet, requestId } = beginRequest(address);
    const previousState =
      state.step === "eligible" || state.step === "not_eligible" ? state : null;
    setState({ step: "claiming" });

    try {
      const walletProof = await requestWalletProof(address, address);

      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      const delegateProofs = getDelegateProofs(
        address,
        walletProofsRef.current,
        primaryWalletRef.current || address
      );
      const claimRes = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          intent: "claim",
          signature: walletProof.signature,
          challenge: walletProof.challenge,
          proof: walletProof.proof,
          delegateProofs: delegateProofs.length > 0 ? delegateProofs : undefined,
        }),
      });

      const data = (await claimRes.json()) as ClaimResponse;

      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      if (!claimRes.ok) {
        setState({ step: "error", message: data.error || data.message || "Claim failed" });
        return;
      }

      applyClaimResponse(data, { celebrate: true });
    } catch (error) {
      if (!isRequestCurrent(normalizedWallet, requestId)) {
        return;
      }

      const message =
        error instanceof Error &&
        (error.message.toLowerCase().includes("user rejected") ||
          error.message.toLowerCase().includes("user denied"))
          ? "Wallet signature was cancelled."
          : error instanceof Error && error.message
            ? error.message
            : "Network error. Please try again.";

      if (previousState) {
        setState(previousState);
        toast.error(message);
        return;
      }

      setState({ step: "error", message });
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Code copied!");
    } catch {
      toast.error("Couldn't copy — please copy manually");
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-16 relative overflow-hidden">
      {/* Background embers */}
      <div className="absolute inset-0 pointer-events-none">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className="ember"
            style={{
              left: `${8 + i * 9}%`,
              top: `${10 + (i % 5) * 18}%`,
              animationDelay: `${i * 0.6}s`,
              animationDuration: `${4 + i * 0.5}s`,
            }}
          />
        ))}
      </div>

      <div className="max-w-lg mx-auto text-center relative z-10 w-full">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 150 }}
          className="mb-6"
        >
          <Image
            src="/shaka.png"
            alt="GVC"
            width={72}
            height={72}
            className="mx-auto drop-shadow-[0_0_25px_rgba(255,224,72,0.3)]"
          />
        </motion.div>

        {/* Title */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-3xl sm:text-4xl font-display font-black text-shimmer leading-tight mb-2"
        >
          Claim Your Pin Pack
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-white/50 font-body text-sm mb-8"
        >
          Exclusive for Cosmic HighKey Moments badge holders
        </motion.p>

        {/* Main Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="rounded-2xl bg-gvc-dark border border-white/[0.08] p-8 mb-6"
        >
          <AnimatePresence mode="wait">
            {/* STATE: Connect Wallet */}
            {state.step === "connect" && (
              <motion.div
                key="connect"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="w-16 h-16 mx-auto rounded-2xl bg-gvc-gold/10 border border-gvc-gold/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-gvc-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 6v3" />
                  </svg>
                </div>
                <p className="text-white/60 font-body text-sm">
                  {addingWallet && primaryWallet
                    ? linkedWalletCount > 0
                      ? "Connect another wallet to link it, or reconnect your main wallet to finish."
                      : "Connect another wallet to link it to this claim."
                    : "Connect your wallet to check if you're eligible for a free GVC pin pack"}
                </p>
                <div className="flex justify-center">
                  <ConnectButton />
                </div>
                {addingWallet && primaryWallet && (
                  <button
                    onClick={() => resetLinkedWalletSession()}
                    className="text-white/30 font-body text-xs hover:text-white/50 transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </motion.div>
            )}

            {/* STATE: Checking */}
            {state.step === "checking" && (
              <motion.div
                key="checking"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6 py-4"
              >
                <div className="w-12 h-12 mx-auto border-2 border-gvc-gold/30 border-t-gvc-gold rounded-full animate-spin" />
                <p className="text-white/60 font-body text-sm">
                  {linkingWallet
                    ? "Linking this wallet to your main claim wallet..."
                    : "Checking your HighKey Moments collection..."}
                </p>
              </motion.div>
            )}

            {/* STATE: Not Eligible */}
            {state.step === "not_eligible" && (
              <motion.div
                key="not_eligible"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="w-16 h-16 mx-auto rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                  <svg className="w-8 h-8 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                </div>
                <div>
                  <p className="text-white font-display text-lg font-bold mb-2">Not Eligible Yet</p>
                  <p className="text-white/50 font-body text-sm mb-4">
                    You need all 3 HighKey Moments tokens to earn the Cosmic badge and claim your pin pack.
                  </p>
                </div>

                {/* Token checklist */}
                <div className="space-y-2">
                  {TOKEN_NAMES.map((name, i) => (
                    <div
                      key={name}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
                        state.held[i]
                          ? "bg-gvc-green/5 border-gvc-green/20"
                          : "bg-white/[0.02] border-white/[0.06]"
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                          state.held[i]
                            ? "bg-gvc-green/20 text-gvc-green"
                            : "bg-white/10 text-white/30"
                        }`}
                      >
                        {state.held[i] ? "✓" : "×"}
                      </div>
                      <span className={`font-body text-sm ${state.held[i] ? "text-white" : "text-white/40"}`}>
                        {name}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Multi-wallet info */}
                {checkedWalletCount > 1 && (
                  <p className="text-white/30 font-body text-xs">
                    Checked {checkedWalletCount} wallets — still missing tokens above
                  </p>
                )}

                {/* Check another wallet */}
                <button
                  onClick={handleAddWallet}
                  disabled={linkingWallet}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white/60 font-body text-sm hover:bg-white/10 hover:text-white/80 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {linkingWallet ? "Linking this wallet..." : "Tokens in another wallet? Check it here"}
                </button>

                <p className="text-white/25 font-body text-xs">
                  We&apos;ll ask you to sign each wallet once before it can count toward a multi-wallet claim.
                </p>

                <button
                  onClick={handleClaim}
                  className="w-full px-4 py-3 rounded-xl bg-gvc-gold/10 border border-gvc-gold/20 text-gvc-gold font-body text-sm hover:bg-gvc-gold/15 transition-all"
                >
                  Already claimed before? Sign to check my code
                </button>

                <button
                  onClick={handleDisconnect}
                  className="mt-1 text-white/30 font-body text-xs hover:text-white/50 transition-colors"
                >
                  Start over
                </button>
              </motion.div>
            )}

            {/* STATE: Eligible */}
            {state.step === "eligible" && (
              <motion.div
                key="eligible"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Badge celebration */}
                <motion.div
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15 }}
                >
                  <div className="relative w-32 h-32 mx-auto">
                    <div className="absolute inset-0 rounded-full bg-gvc-gold/20 animate-pulse" />
                    <Image
                      src={BADGE_IMAGE_URL}
                      alt="HighKey Moments Badge"
                      width={128}
                      height={128}
                      className="relative rounded-full object-cover border-2 border-gvc-gold/40"
                    />
                  </div>
                </motion.div>

                <div>
                  <p className="text-gvc-gold font-display text-xl font-bold mb-1">
                    {state.soldOut ? "Currently Sold Out" : "You're Eligible!"}
                  </p>
                  <p className="text-white/50 font-body text-sm">
                    {state.soldOut
                      ? state.message || "New claims are sold out. If this wallet already claimed a code, sign to view it again."
                      : state.claimable
                      ? "Cosmic HighKey Moments badge holder confirmed. Sign with your wallet to claim your one-time code."
                      : state.message || "Eligible! Discount codes not yet loaded — check back soon."}
                  </p>
                </div>

                {state.claimable && (
                  <button
                    onClick={handleClaim}
                    className="w-full px-6 py-4 rounded-xl bg-gvc-gold text-gvc-black font-display font-bold text-center hover:shadow-[0_0_30px_rgba(255,224,72,0.3)] transition-all"
                  >
                    {state.soldOut ? "Sign To Check My Code" : "Sign To Claim My Discount Code"}
                  </button>
                )}

                <button
                  onClick={handleDisconnect}
                  className="text-white/30 font-body text-xs hover:text-white/50 transition-colors"
                >
                  Disconnect wallet
                </button>
              </motion.div>
            )}

            {/* STATE: Claiming */}
            {state.step === "claiming" && (
              <motion.div
                key="claiming"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6 py-4"
              >
                <div className="w-12 h-12 mx-auto border-2 border-gvc-gold/30 border-t-gvc-gold rounded-full animate-spin" />
                <p className="text-white/60 font-body text-sm">
                  Claiming your pin pack...
                </p>
              </motion.div>
            )}

            {/* STATE: Claimed! */}
            {state.step === "claimed" && (
              <motion.div
                key="claimed"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Badge celebration */}
                <motion.div
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15 }}
                >
                  <div className="relative w-32 h-32 mx-auto">
                    <div
                      className="absolute inset-0 rounded-full"
                      style={{ animation: "glowPulse 2s ease-in-out infinite" }}
                    />
                    <Image
                      src={BADGE_IMAGE_URL}
                      alt="HighKey Moments Badge"
                      width={128}
                      height={128}
                      className="relative rounded-full object-cover border-2 border-gvc-gold/60"
                    />
                  </div>
                </motion.div>

                <div>
                  <p className="text-gvc-gold font-display text-xl font-bold mb-1">Pin Pack Claimed! 🤙</p>
                  <p className="text-white/50 font-body text-sm mb-4">
                    Use this code at checkout for your free pin pack
                  </p>
                </div>

                {/* Discount code */}
                <button
                  onClick={() => copyCode(state.code)}
                  className="w-full group relative"
                >
                  <div className="card-glow rounded-xl bg-black/60 border border-gvc-gold/30 px-6 py-4 transition-all hover:border-gvc-gold/50">
                    <p className="text-xs text-white/40 font-body mb-1">YOUR DISCOUNT CODE</p>
                    <p className="text-2xl font-display font-bold text-gvc-gold tracking-wider">
                      {state.code}
                    </p>
                  </div>
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-body text-white/30 group-hover:text-white/50 transition-colors">
                    Click to copy
                  </span>
                </button>

                {/* Shopify CTA */}
                <a
                  href={SHOPIFY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full px-6 py-4 rounded-xl bg-gvc-gold text-gvc-black font-display font-bold text-center hover:shadow-[0_0_30px_rgba(255,224,72,0.3)] transition-all"
                >
                  Claim on Shopify →
                </a>

                <p className="text-white/25 font-body text-xs">
                  This is a single-use code. Apply it at checkout for 100% off your pin pack.
                </p>

                <button
                  onClick={handleDisconnect}
                  className="text-white/30 font-body text-xs hover:text-white/50 transition-colors"
                >
                  Disconnect wallet
                </button>
              </motion.div>
            )}

            {/* STATE: Error */}
            {state.step === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="w-16 h-16 mx-auto rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                </div>
                <p className="text-white/60 font-body text-sm">{state.message}</p>
                <button
                  onClick={() => address && loadClaimStatus(address)}
                  className="px-6 py-3 rounded-xl bg-white/5 border border-white/10 text-white font-body text-sm hover:bg-white/10 transition-colors"
                >
                  Try Again
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="flex items-center justify-center gap-3"
        >
          <Image src="/gvc-logotype.svg" alt="Good Vibes Club" width={100} height={20} className="opacity-30" />
        </motion.div>
      </div>
    </main>
  );
}
