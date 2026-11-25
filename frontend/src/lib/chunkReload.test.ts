import { describe, expect, it, vi } from "vitest";

import { isChunkLoadError, reloadOnceForStaleChunk } from "./chunkReload";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}

describe("stale chunk reload", () => {
  it("recognises dynamic import failures from Chrome, Firefox and Safari", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/page-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });

  it("reloads once, then stops inside the 30s window", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForStaleChunk(storage, 1_000_000, reload)).toBe(true);
    expect(reloadOnceForStaleChunk(storage, 1_010_000, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForStaleChunk(storage, 1_040_001, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
