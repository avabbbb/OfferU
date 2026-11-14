// Web-build data facade for the data-package / WebDAV dialog and the showcase
// reset. The data itself lives in the browser runtime's IndexedDB store
// (packages/core IdbCoreStore, database "offeru"), one row per record; the old
// single-blob localforage store ("offeru-demo") is migrated into it once, on
// first open (lib/runtime/browserRuntime readLegacyState).

import { emptyState } from "@offeru/core";

import { DEMO_SEED } from "@/lib/runtime/mode";
import { buildDemoState, type DemoState } from "./seed";

async function store() {
  const { browserStore } = await import("@/lib/runtime/browserRuntime");
  const instance = browserStore();
  await instance.ready();
  return instance;
}

export const demoStore = {
  async ready(): Promise<void> {
    await store();
  },

  /** A copy of everything in this browser (records + change log). */
  async snapshot(): Promise<DemoState> {
    return (await (await store()).exportState()) as DemoState;
  },

  /** Replace everything atomically, e.g. after importing a data package. */
  async replace(next: DemoState): Promise<void> {
    await (await store()).replaceState(next);
  },

  /** Back to the starting point: demo seed on the showcase, empty on the TO C web app. */
  async reset(): Promise<void> {
    await (await store()).replaceState(DEMO_SEED ? buildDemoState() : emptyState());
  },

  /** Writes commit per transaction now; kept for callers that still await it. */
  async flush(): Promise<void> {
    return undefined;
  },
};

export async function resetDemoData(): Promise<void> {
  await demoStore.reset();
}
