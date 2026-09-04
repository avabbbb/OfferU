import { describe, expect, it } from "vitest";

import {
  DEFAULT_OFFERU_FRONTEND_PORT,
  DEFAULT_OFFERU_FRONTEND_URL,
  DEFAULT_OFFERU_SERVER_URL,
  normalizeOfferUFrontendPort,
  normalizeOfferUServerUrl,
} from "./server-url.js";

describe("OfferU server URL boundary", () => {
  it("normalizes legacy local web and provider ports to the backend", () => {
    expect(normalizeOfferUServerUrl("http://127.0.0.1:8080/")).toBe(DEFAULT_OFFERU_SERVER_URL);
    expect(normalizeOfferUServerUrl("http://localhost:8000/api")).toBe(DEFAULT_OFFERU_SERVER_URL);
    expect(normalizeOfferUServerUrl("http://localhost:7410/")).toBe(DEFAULT_OFFERU_SERVER_URL);
  });

  it("keeps the current local backend and remote custom origin", () => {
    expect(normalizeOfferUServerUrl("http://localhost:8765/api")).toBe(DEFAULT_OFFERU_SERVER_URL);
    expect(normalizeOfferUServerUrl("https://example.test:9443/offeru")).toBe(
      "https://example.test:9443",
    );
  });

  it("pins the desktop web launcher to the OfferU frontend port", () => {
    expect(normalizeOfferUFrontendPort("8080")).toBe(DEFAULT_OFFERU_FRONTEND_PORT);
    expect(normalizeOfferUFrontendPort("3000")).toBe(DEFAULT_OFFERU_FRONTEND_PORT);
    expect(normalizeOfferUFrontendPort("7410")).toBe(DEFAULT_OFFERU_FRONTEND_PORT);
    expect(DEFAULT_OFFERU_FRONTEND_URL).toBe("http://127.0.0.1:7410");
  });
});
