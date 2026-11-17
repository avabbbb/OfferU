import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { ConfigStore, StoredConfig } from "@offeru/core";

/**
 * Companion ConfigStore: <data>/offeru-ts-config.json, owner-only (0600). Keys
 * are stored as entered; the OS keychain integration of the Python backend is
 * not ported yet. A missing or corrupt file reads as "nothing configured".
 */
export function nodeConfigFile(path: string, legacyPythonConfig?: string): ConfigStore {
  return {
    async load() {
      if (!existsSync(path)) return legacyPythonConfig ? importPythonConfig(legacyPythonConfig) : null;
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<StoredConfig> : null;
      } catch {
        return null;
      }
    },
    async save(config) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
    },
  };
}

const LEGACY_KEY_FIELDS = ["deepseek_api_key", "openai_api_key", "qwen_api_key", "siliconflow_api_key", "gemini_api_key", "zhipu_api_key", "active_llm_api_key"];

/**
 * First start after the Python desktop build: take the model list from its <data>/config.json.
 * Python kept the keys in the OS keychain (config.json only has credential_ref), which Node
 * cannot read without a native module, so every key comes over empty: the user re-enters it once.
 * Nothing is written until the user saves.
 */
export function importPythonConfig(file: string): Partial<StoredConfig> | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const configs = Array.isArray(raw.llm_api_configs) ? raw.llm_api_configs : [];
    const out: Record<string, unknown> = { ...raw };
    for (const field of LEGACY_KEY_FIELDS) out[field] = "";
    out.llm_api_configs = configs
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(({ credential_ref: _ref, api_key: _key, ...item }) => ({ ...item, api_key: "" }));
    return out as Partial<StoredConfig>;
  } catch {
    return null;
  }
}
