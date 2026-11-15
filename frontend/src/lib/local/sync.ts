// Browser storage for S3/R2 sync (web build and showcase). The controller is the same
// SyncService the desktop companion runs (backend-ts/src/syncService.ts); only where its
// settings and state live differs:
//
//   settings   IndexedDB. Endpoint / bucket / region / prefix / key id are plain.
//              Secret Access Key and the sync passphrase are either
//                remember = true  : AES-GCM encrypted with this browser's non-extractable
//                                   device key (demo/keyVault, same as model API keys), or
//                remember = false : kept in this module's memory only; after a reload the
//                                   panel asks for them again.
//              Why not encrypt them with the passphrase-derived key: the passphrase is one of
//              the secrets, so it would have to be typed on every visit anyway, which is
//              exactly the session-only option. The device key protects at-rest IndexedDB
//              (disk images, other profiles); same-origin script can still use it.
//   state      IndexedDB (three-way base, uid map, upload checkpoint). Never uploaded.

import localforage from "localforage";
import type { SyncState, SyncStateStore } from "@offeru/sync";
import type { StoredSyncSettings, SyncSettingsStore } from "@offeru/backend/syncService";

import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/lib/demo/keyVault";

type AtRest = Omit<StoredSyncSettings, "secretAccessKey" | "passphrase"> & {
  remember: boolean;
  secret?: EncryptedSecret;
  passphraseSecret?: EncryptedSecret;
};

const SETTINGS_KEY = "s3:v2";
const STATE_KEY = "s3-state:v1";

export function indexedDbSyncStores(database: string): { settings: SyncSettingsStore; state: SyncStateStore } {
  const box = localforage.createInstance({ name: database, storeName: "s3" });
  let session: { secretAccessKey: string; passphrase: string } | null = null;

  const settings: SyncSettingsStore = {
    async load() {
      const stored = await box.getItem<AtRest>(SETTINGS_KEY);
      if (!stored) return null;
      const { remember, secret, passphraseSecret, ...rest } = stored;
      let secrets = { secretAccessKey: "", passphrase: "" };
      if (remember) {
        try {
          secrets = { secretAccessKey: await decryptSecret(secret), passphrase: await decryptSecret(passphraseSecret) };
        } catch {
          secrets = { secretAccessKey: "", passphrase: "" }; // site data / device key cleared: re-enter
        }
      } else if (session) {
        secrets = session;
      }
      return { ...rest, ...secrets };
    },
    async save({ secretAccessKey, passphrase, ...rest }, { remember }) {
      const stored: AtRest = { ...rest, remember };
      if (remember) {
        stored.secret = await encryptSecret(secretAccessKey);
        stored.passphraseSecret = await encryptSecret(passphrase);
        session = null;
      } else {
        session = { secretAccessKey, passphrase };
      }
      await box.setItem(SETTINGS_KEY, stored);
    },
    async clear() {
      session = null;
      await box.removeItem(SETTINGS_KEY);
    },
    secretsMode: async () => ((await box.getItem<AtRest>(SETTINGS_KEY))?.remember === false ? "session" : "stored"),
  };

  const state: SyncStateStore = {
    load: async () => (await box.getItem<SyncState>(STATE_KEY)) ?? null,
    save: async (value) => {
      await box.setItem(STATE_KEY, value);
    },
  };
  return { settings, state };
}
