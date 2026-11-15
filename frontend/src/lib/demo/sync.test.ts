import { describe, expect, it, vi } from "vitest";

import { buildDemoPackage } from "./package";
import { buildDemoState } from "./seed";
import { downloadDemoSnapshot, joinWebDavUrl, testWebDav, uploadDemoSnapshot, WEBDAV_FILE } from "./sync";

const config = { url: "https://dav.example.test/me", remoteDir: "offeru", username: "u", password: "p" };

describe("WebDAV snapshot sync", () => {
  it("joins paths without double slashes", () => {
    expect(joinWebDavUrl("https://dav.example.test/me/", "offeru", "x.json")).toBe("https://dav.example.test/me/offeru/x.json");
  });

  it("creates the remote directory only when missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 207 }));
    await expect(testWebDav(config, fetchMock)).resolves.toEqual({ dirCreated: false });
    expect(fetchMock).toHaveBeenCalledWith("https://dav.example.test/me/offeru/", expect.objectContaining({ method: "PROPFIND" }));
  });

  it("uploads a versioned package and downloads it back", async () => {
    const state = buildDemoState();
    const payload = buildDemoPackage(state, new Date("2026-11-11T12:00:00Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 207 }))
      .mockResolvedValueOnce(new Response("", { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    const uploaded = await uploadDemoSnapshot(config, state, fetchMock);
    expect(uploaded.payload.data.records.length).toBe(state.records.length);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://dav.example.test/me/offeru/${WEBDAV_FILE}`);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");

    const downloaded = await downloadDemoSnapshot(config, fetchMock);
    expect(downloaded?.data.records.length).toBe(state.records.length);
    expect(fetchMock.mock.calls[2][1]?.method).toBe("GET");
  });
});
