import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import App from "./App";
import { RPC_URL, X1, politeFetch } from "./chain";
import { DevnetBurnerAdapter } from "./burner";

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new DevnetBurnerAdapter()], []);
  // The public devnet RPC rate-limits hard; retrying every 429 multiplies the load, so the pages
  // keep their last data and try again on their next refresh instead, and requests go out one
  // after the other, 120 ms apart. X1's RPC does not throttle: there they all go at once (in a
  // line, a visitor far from the RPC waited twenty round trips, one after the other, for one screen).
  const rpcFetch = useMemo(() => politeFetch(X1 ? 0 : 120), []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed", disableRetryOnRateLimit: true, fetch: rpcFetch }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Root /></React.StrictMode>);
