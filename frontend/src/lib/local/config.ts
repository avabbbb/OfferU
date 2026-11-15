// Browser ConfigStore for /api/config: the user's model settings in IndexedDB.
// API keys never sit in plaintext at rest: each is AES-GCM encrypted with this browser's
// non-extractable device key (demo/keyVault). Same-origin script can still use them.

import localforage from "localforage";
import type { ConfigStore, StoredConfig } from "@offeru/core";

import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/lib/demo/keyVault";

type AtRest = Omit<Partial<StoredConfig>, "llm_api_configs"> & {
  llm_api_configs?: (Record<string, unknown> & { secret?: EncryptedSecret })[];
};

const LEGACY_KEYS = ["deepseek_api_key", "openai_api_key", "qwen_api_key", "siliconflow_api_key", "gemini_api_key", "zhipu_api_key", "active_llm_api_key"];
const KEY = "config:v1";

export function indexedDbConfigStore(database = "offeru-local-config"): ConfigStore {
  const db = localforage.createInstance({ name: database, storeName: "config" });
  return {
    async load() {
      const stored = await db.getItem<AtRest>(KEY);
      if (!stored) return null;
      const configs = await Promise.all((stored.llm_api_configs ?? []).map(async ({ secret, ...item }) => {
        let apiKey = "";
        try {
          apiKey = await decryptSecret(secret);
        } catch {
          apiKey = ""; // site data / device key cleared: the user re-enters the key
        }
        return { ...item, api_key: apiKey };
      }));
      return { ...stored, llm_api_configs: configs } as Partial<StoredConfig>;
    },
    async save(config) {
      const configs = await Promise.all(config.llm_api_configs.map(async ({ api_key, ...item }) => ({
        ...item,
        api_key: "",
        ...(api_key && !/^env:/i.test(api_key) ? { secret: await encryptSecret(api_key) } : {}),
      })));
      const rest: Record<string, unknown> = { ...config };
      for (const field of LEGACY_KEYS) rest[field] = "";
      await db.setItem(KEY, { ...rest, llm_api_configs: configs });
    },
  };
}
