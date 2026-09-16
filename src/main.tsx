import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arc } from "./lib/arc";
import { Deployer } from "./Deployer";
import "./styles.css";

const queryClient = new QueryClient();
const config = createConfig({ chains: [arc], connectors: [injected()], transports: { [arc.id]: http(arc.rpcUrls.default.http[0]) } });

createRoot(document.getElementById("root")!).render(
  <StrictMode><WagmiProvider config={config}><QueryClientProvider client={queryClient}><Deployer /></QueryClientProvider></WagmiProvider></StrictMode>,
);
