import { useConnect, type Connector } from "wagmi";

function hasInjectedProvider() {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
}

/** Prefer a wallet announced via EIP-6963 (MetaMask first), then the generic injected provider. */
function pickConnector(connectors: readonly Connector[]): Connector | undefined {
  const announced = connectors.filter((c) => c.id !== "injected");
  return announced.find((c) => /metamask/i.test(c.name) || c.id === "io.metamask")
    ?? announced[0]
    ?? connectors.find((c) => c.id === "injected");
}

function explain(error: unknown): string {
  const e = error as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = e?.code ?? e?.cause?.code;
  const text = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  if (e?.name === "ProviderNotFoundError" || /provider not found/i.test(text)) return "No browser wallet found. Install MetaMask, then reload this page.";
  if (code === -32002 || /already pending/i.test(text)) return "MetaMask already has a request open. Click the MetaMask icon in your toolbar to finish or cancel it, then try again.";
  if (code === 4001 || /rejected|denied/i.test(text)) return "The connection request was rejected in the wallet.";
  if (/already connected/i.test(text)) return "The wallet is already connected. Reload the page.";
  return e?.shortMessage || e?.message || "The wallet did not connect.";
}

/** Shared connect action for every "Connect wallet" button, with a readable error. */
export function useWalletConnect() {
  const { connectors, connect, isPending, error, reset } = useConnect();
  const connector = pickConnector(connectors);
  const walletAvailable = Boolean(connector && (connector.id !== "injected" || hasInjectedProvider()));
  return {
    walletAvailable,
    isPending,
    error: !walletAvailable ? "No browser wallet found. Install MetaMask, then reload this page." : error ? explain(error) : undefined,
    connectWallet: () => {
      reset();
      if (connector) connect({ connector });
    },
  };
}
