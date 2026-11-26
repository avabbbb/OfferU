import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";

import "@/app/globals.css";
import { Providers } from "@/app/providers";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";
import { OfferURoutes } from "@/vite/OfferURoutes";
import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { installStaleChunkReload } from "@/lib/chunkReload";

installStaleChunkReload();

const PairPage = lazy(() => import("@/vite/PairPage"));
const SyncPairPage = lazy(() => import("@/vite/SyncPairPage"));

// Web build (VITE_OFFERU_MODE=local-web): serve /api/* from the in-page backend before anything fetches.
if (import.meta.env.VITE_OFFERU_MODE === "local-web") {
  const { installLocalBackend } = await import("@/lib/local/backend");
  installLocalBackend();
}

const root = document.getElementById("root");
if (!root) throw new Error("OfferU root element was not found");

document.body.className =
  "offeru-viewport-min-height overflow-hidden text-[var(--foreground)] antialiased";

createRoot(root).render(
  <AppErrorBoundary>
  <HashRouter>
    <Routes>
      <Route path="/pair/:code" element={<Suspense fallback={null}><PairPage /></Suspense>} />
      {/* `offeru sync pair` link: one passphrase field, outside the workbench shell. */}
      <Route path="/sync/pair" element={<Suspense fallback={null}><SyncPairPage /></Suspense>} />
      <Route path="*" element={
        <Providers>
          <WorkbenchShell>
            <OfferURoutes />
          </WorkbenchShell>
        </Providers>
      } />
    </Routes>
  </HashRouter>
  </AppErrorBoundary>,
);
