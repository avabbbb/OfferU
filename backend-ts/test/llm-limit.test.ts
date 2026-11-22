import { describe, expect, it } from "vitest";

import { ModelCallLimiter, limitLlm, type LlmClient } from "@offeru/core";

describe("ModelCallLimiter", () => {
  it("caps concurrent requests per provider; other providers are not blocked; abort leaves the queue", async () => {
    const limiter = new ModelCallLimiter(() => 2);
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const slow = (provider: string): LlmClient => ({
      provider,
      async chat() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
        return "ok";
      },
    });
    const a = limitLlm(slow("deepseek"), limiter);
    const calls = [a.chat([]), a.chat([]), a.chat([])];
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(limiter.snapshot().deepseek).toEqual({ active: 2, waiting: 1 });

    const other = limitLlm(slow("kimi"), limiter);
    const otherCall = other.chat([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(limiter.snapshot().kimi).toEqual({ active: 1, waiting: 0 });

    const controller = new AbortController();
    const cancelled = a.chat([], { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeTruthy();
    expect(limiter.snapshot().deepseek.waiting).toBe(1);

    while (gates.length) { gates.shift()!(); await new Promise((resolve) => setTimeout(resolve, 2)); }
    await Promise.all([...calls, otherCall]);
    expect(peak).toBeLessThanOrEqual(3); // 2 deepseek + 1 kimi at most
    expect(limiter.snapshot().deepseek).toEqual({ active: 0, waiting: 0 });
    expect(limitLlm(a, limiter)).toBe(a); // never double-wrapped (two slots per call could deadlock)
    expect(limitLlm(slow("x"), limiter).provider).toBe("x");
  });
});
