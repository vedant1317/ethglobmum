import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { sepolia } from "wagmi/chains";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { deployment, sepoliaRpc } from "@/lib/config";
import { AppShell } from "@/components/AppShell";
import { DashboardPage } from "@/pages/DashboardPage";
import { VerifyPage } from "@/pages/VerifyPage";
import { PromotePage } from "@/pages/PromotePage";
import { ReleasesPage } from "@/pages/ReleasesPage";

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: sepoliaRpc ?? http() },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

function App() {
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><BrowserRouter>
    <Routes><Route element={<AppShell />}>
      <Route index element={<DashboardPage />} />
      <Route path="verify" element={<VerifyPage />} />
      <Route path="promote" element={<PromotePage />} />
      <Route path="releases" element={<ReleasesPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route></Routes>
  </BrowserRouter></QueryClientProvider></WagmiProvider>;
}

document.title = `ENSure · ${deployment.projectName}`;
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
