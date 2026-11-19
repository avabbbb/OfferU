// Step budget of one built-in Agent Run. Kept dependency-free so config.ts can
// use it without importing the prompt / tool modules.

/** Default tool-step budget per Run (config `agent_max_steps`, request `max_steps` override it). */
export const MAX_STEPS = 12;
/** Upper bound for a configured or requested budget (routes/agent.ts uses the same 0–40 check). */
export const MAX_STEPS_LIMIT = 40;

/** Agent step budget: integer 1–40, else the default. */
export function normalizeMaxSteps(value: unknown): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 1 && number <= MAX_STEPS_LIMIT ? number : MAX_STEPS;
}
