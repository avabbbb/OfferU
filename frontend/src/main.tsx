import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";

import "@/app/globals.css";
import "@/app/resume/components/templates/resumeTemplate.css";
import { Providers } from "@/app/providers";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";
import { OfferURoutes } from "@/vite/OfferURoutes";

const ResumePrintPage = lazy(() => import("@/app/resume/print/[id]/page"));

const root = document.getElementById("root");
if (!root) throw new Error("OfferU root element was not found");

document.body.className =
  "offeru-viewport-min-height overflow-hidden bg-[var(--background)] text-[var(--foreground)] antialiased";

createRoot(root).render(
  <HashRouter>
    <Routes>
      <Route path="/resume/print/:id" element={<Suspense fallback={<p>正在排版…</p>}><ResumePrintPage /></Suspense>} />
      <Route path="*" element={
        <Providers>
          <WorkbenchShell>
            <OfferURoutes />
          </WorkbenchShell>
        </Providers>
      } />
    </Routes>
  </HashRouter>,
);
