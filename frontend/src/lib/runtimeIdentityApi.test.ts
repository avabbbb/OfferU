import { describe, expect, it } from "vitest";
import { matchesDesktopRuntimeIdentity } from "./runtimeIdentityApi";

const expected = {
  runtime_instance_id: "4cb704f3-df88-4fbf-9e8c-1a10ef96ea7d",
  version: "0.4.0",
  commit: "a".repeat(40),
  build_timestamp: "2026-10-02T01:02:03.000Z",
  dirty: false,
  source_fingerprint: `sha256:${"b".repeat(64)}`,
  data_root: "C:\\Users\\ava\\AppData\\Local\\OfferU",
  runtime_type: "desktop-sidecar",
};

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    service: "OfferU",
    runtime: "python",
    build_mode: "release",
    runtime_mode: "desktop-sidecar",
    version: "0.4.0",
    runtime_instance_id: expected.runtime_instance_id,
    build_identity: {
      version: expected.version,
      commit: expected.commit,
      build_timestamp: expected.build_timestamp,
      dirty: expected.dirty,
      source_fingerprint: expected.source_fingerprint,
      data_root: "c:/users/ava/AppData/Local/OfferU/",
      runtime_type: expected.runtime_type,
      build_source: "package",
    },
    ...overrides,
  };
}

describe("matchesDesktopRuntimeIdentity", () => {
  it("allows the current packaged runtime when native and backend identities match", () => {
    expect(matchesDesktopRuntimeIdentity(expected, health(), "release")).toBe(true);
  });

  it("rejects a same-version sidecar owned by an older Desktop instance", () => {
    expect(
      matchesDesktopRuntimeIdentity(
        expected,
        health({ runtime_instance_id: "cc6de107-688d-4b09-a0c4-859019b4ff05" }),
        "release",
      ),
    ).toBe(false);
  });

  it("rejects health responses without an instance or build identity", () => {
    expect(matchesDesktopRuntimeIdentity(expected, health({ runtime_instance_id: undefined }), "release")).toBe(false);
    expect(matchesDesktopRuntimeIdentity(expected, health({ build_identity: undefined }), "release")).toBe(false);
  });

  it("keeps source Desktop builds explicitly unbuilt and accepts their owned local runtime", () => {
    const sourceExpected = {
      ...expected,
      build_timestamp: null,
      dirty: true,
      source_fingerprint: null,
    };
    const sourceHealth = health({
      build_mode: "local-development",
      build_identity: {
        ...health().build_identity,
        build_timestamp: null,
        dirty: true,
        source_fingerprint: null,
        build_source: "source",
      },
    });

    expect(matchesDesktopRuntimeIdentity(sourceExpected, sourceHealth, "source")).toBe(true);
  });
});
