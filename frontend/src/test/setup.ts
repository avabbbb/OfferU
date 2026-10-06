import "@testing-library/jest-dom/vitest";

// Polyfill ResizeObserver for jsdom (required by HeroUI Tabs/Select components)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
