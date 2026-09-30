import { useAgentConnection } from "@/lib/agentConnection";
import { useEmailStatus, useJobs, useProfile } from "@/lib/hooks";
import type { SetupStep } from "@/lib/useOnboarding";

export function useSetupProgress() {
  const agent = useAgentConnection();
  const profile = useProfile();
  const jobs = useJobs({ page_size: 1 });
  const email = useEmailStatus();
  const agentVerified = Boolean(agent.connection?.connection_verified && agent.connection.status === "ready");
  const steps: Array<{ key: SetupStep; label: string; done: boolean }> = [
    { key: "profile", label: "建立职业档案", done: !profile.error && Boolean(profile.data?.sections?.some((section) => section.tier === "verified_fact")) },
    { key: "job", label: "保存第一个岗位", done: !jobs.error && Boolean(jobs.data?.items?.length) },
    { key: "agent", label: "连接你的 Agent（可稍后）", done: agentVerified },
    { key: "email", label: "连接求职邮箱", done: !email.error && Boolean(email.data?.connected) },
  ];
  return {
    agent, profile, jobs, email, agentVerified, steps,
    nextStep: steps.find((step) => !step.done)?.key || "today",
    completed: steps.filter((step) => step.done).length,
    coreComplete: steps.filter((step) => step.key !== "email" && step.key !== "agent").every((step) => step.done),
    loading: profile.isLoading || jobs.isLoading,
    error: profile.error || jobs.error,
    emailError: email.error,
    refresh: () => Promise.allSettled([profile.mutate(), jobs.mutate(), email.mutate()]),
  };
}
