import { lazy, Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useOnboarding } from "@/lib/useOnboarding";
import { SHOWCASE } from "@/lib/showcase/router";

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then((module) => ({ default: module.OnboardingWizard })));

export function OnboardingGate({ children }: { children: ReactNode }) {
  const { shouldShowWizard, wizardStep, setWizardStep, completeWizard, skipWizard } = useOnboarding();
  const pathname = usePathname();
  return <>
    {children}
    {!SHOWCASE && shouldShowWizard && pathname === "/" && <Suspense fallback={null}>
      <OnboardingWizard
        wizardStep={wizardStep}
        onStepChange={setWizardStep}
        onComplete={completeWizard}
        onSkip={skipWizard}
      />
    </Suspense>}
  </>;
}
