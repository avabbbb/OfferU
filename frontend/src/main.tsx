import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";

import "@/app/globals.css";
import "@/app/resume/components/templates/resumeTemplate.css";
import { Providers } from "@/app/providers";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";
import { OfferURoutes } from "@/vite/OfferURoutes";

const root = document.getElementById("root");
if (!root) throw new Error("OfferU root element was not found");

document.body.className =
  "h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)] antialiased";

createRoot(root).render(
  <HashRouter>
    <Providers>
      <WorkbenchShell>
        <OfferURoutes />
      </WorkbenchShell>
    </Providers>
  </HashRouter>,
);
