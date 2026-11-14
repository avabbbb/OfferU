// Companion settings host: the user's model config (API keys included) and the
// platform-consent record as files in the local data directory.
//
// - llm-config.json is written with mode 0600 (owner-only) through a temp file
//   + rename, so a crash never leaves half a key file behind.
// - Keys never go to a log, the repo, or the Worker; GET /api/config masks them.
// - First run imports the non-secret parts (and any plain keys) of the Python
//   backend's config.json in the same data dir. Keys Python kept in the OS
//   keychain (credential_ref) cannot be read without a native module, so the
//   user re-enters those once; vault_status reports how many.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { dirname, join } from "node:path";

import { coerceLlmConfig, defaultLlmConfig, normalizeLlmConfig, type ConsentRecord, type LlmConfigState } from "@offeru/core";

import { dbPath } from "./paths";
import type { SettingsHost } from "@offeru/core";

export const LLM_CONFIG_FILE = "llm-config.json";
export const CONSENT_FILE = "platform-consent.json";
const PYTHON_CONFIG_FILE = "config.json";

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

export function nodeSettings(dataDir = dirname(dbPath()), options: { fetch?: typeof fetch; production?: boolean } = {}): SettingsHost {
  const configPath = join(dataDir, LLM_CONFIG_FILE);
  const consentPath = join(dataDir, CONSENT_FILE);
  let cached: LlmConfigState | null = null;
  let unreadable = 0;
  let error = "";

  function load(): LlmConfigState {
    if (cached) return cached;
    const own = readJson(configPath);
    if (own !== null) {
      try {
        cached = normalizeLlmConfig(coerceLlmConfig(own));
        return cached;
      } catch (cause) {
        error = `${LLM_CONFIG_FILE} 格式损坏，已用默认配置：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    const legacy = readJson(join(dataDir, PYTHON_CONFIG_FILE));
    if (legacy && typeof legacy === "object") {
      try {
        const imported = normalizeLlmConfig(coerceLlmConfig(legacy));
        unreadable = imported.llm_api_configs.filter((item) => !item.api_key && item.credential_ref).length;
        cached = imported;
        return cached;
      } catch {
        // fall through to defaults
      }
    }
    cached = defaultLlmConfig();
    return cached;
  }

  return {
    loadLlmConfig: load,
    async saveLlmConfig(next) {
      writePrivate(configPath, JSON.stringify(next, null, 2));
      cached = next;
      unreadable = next.llm_api_configs.filter((item) => !item.api_key && item.credential_ref).length;
      error = "";
    },
    vaultStatus: () => ({ available: true, error, read_error_count: unreadable }),
    loadConsent() {
      const record = readJson(consentPath);
      return record && typeof record === "object" && !Array.isArray(record) ? record as ConsentRecord : null;
    },
    async saveConsent(record) {
      if (record === null) {
        rmSync(consentPath, { force: true });
        // Python revoke also clears the authorized-browsing Chrome profile (platform logins).
        rmSync(join(dataDir, "chrome-profile"), { recursive: true, force: true });
        return;
      }
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(consentPath, JSON.stringify(record), "utf8");
    },
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    resolveHost: async (host) => (await lookup(host, { all: true })).map((item) => item.address),
    production: options.production ?? process.env.OFFERU_ENV === "production",
  };
}
