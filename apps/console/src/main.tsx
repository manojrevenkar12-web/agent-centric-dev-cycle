import "@fontsource/atkinson-hyperlegible-next/400";
import "@fontsource/atkinson-hyperlegible-next/700";
import "@fontsource/atkinson-hyperlegible-mono/400";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./shared/theme/global.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
