import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { IdbCoreStore } from "@offeru/core/idb";
import { runStoreContract } from "@offeru/core/testing";

import { openStore } from "../src/store";

let dbCounter = 0;

runStoreContract("sqlite", async () => openStore(":memory:"), { describe, it, expect });
runStoreContract("indexeddb", async () => {
  const store = new IdbCoreStore({ name: `contract-${Date.now()}-${dbCounter++}` });
  await store.ready();
  return store;
}, { describe, it, expect });
