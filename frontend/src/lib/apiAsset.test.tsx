// Web build: /api/* images and links must be read through the in-page backend, never the Worker.
import fs from "node:fs";
import path from "node:path";

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local/mode", () => ({ LOCAL_WEB: true, OFFERU_MODE: "local-web" }));

import { ApiImg, isInPageApiUrl } from "./apiAsset";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isInPageApiUrl", () => {
  it("is true only for same-origin /api/* URLs in the web build", () => {
    expect(isInPageApiUrl("/api/files/a.png", true)).toBe(true);
    expect(isInPageApiUrl(`${location.origin}/api/resume/assets/school-logos/0001.png`, true)).toBe(true);
    expect(isInPageApiUrl("/api/files/a.png", false)).toBe(false);
    expect(isInPageApiUrl("/school-logos/0001.png", true)).toBe(false);
    expect(isInPageApiUrl("https://example.com/api/x", true)).toBe(false);
    expect(isInPageApiUrl("data:image/png;base64,AA", true)).toBe(false);
    expect(isInPageApiUrl(null, true)).toBe(false);
  });
});

describe("ApiImg", () => {
  it("loads /api/* through fetch and shows a blob: URL", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) }));
    vi.stubGlobal("fetch", fetchMock);
    if (!URL.createObjectURL) Object.assign(URL, { createObjectURL: () => "", revokeObjectURL: () => undefined });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local/1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { container } = render(<ApiImg src="/api/files/photo.png" alt="p" />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:local/1"), { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledWith("/api/files/photo.png");
  });

  it("leaves other URLs alone", () => {
    const { container } = render(<ApiImg src="https://cdn.example.com/a.png" alt="" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example.com/a.png");
  });
});

// Static guard: an <img>/<a> pointing straight at /api/* bypasses the fetch wrapper and would
// reach the Cloudflare Worker on the web build. Use ApiImg / useApiAssetUrl instead.
describe("no direct /api/* element URLs", () => {
  it("has no <img src>/<a href> built from apiUrl()/attachmentUrl or an /api/ literal", () => {
    const root = path.resolve(__dirname, "..");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          const re = /<(img|a|iframe|source|video|audio)\b[^>]*\b(src|href)=\{[^}]*(apiUrl\(|attachmentUrl|imageUrl\(|["'`]\/api\/)/g;
          for (const m of text.matchAll(re)) bad.push(`${path.relative(root, full)}: ${m[0].slice(0, 80)}`);
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
