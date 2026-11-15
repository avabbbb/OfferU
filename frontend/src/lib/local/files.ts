// Browser file stores for the in-page backend: uploads, Agent attachments and named
// backups live in IndexedDB (localforage), one database per kind. Same FileStore /
// BackupFiles contracts the companion implements on disk.

import localforage from "localforage";
import { guessMime, type BackupFiles, type FileStore } from "@offeru/core";

const safe = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base === "." || base === ".." ? "" : base;
};

function bytesDb(database: string) {
  const db = localforage.createInstance({ name: database, storeName: "files" });
  return {
    get: async (name: string) => (safe(name) ? db.getItem<Uint8Array>(safe(name)) : null),
    set: async (name: string, bytes: Uint8Array) => {
      if (!safe(name)) throw new Error("文件名不合法");
      await db.setItem(safe(name), bytes);
    },
    keys: () => db.keys(),
  };
}

export function indexedDbFileStore(database: string): FileStore {
  const db = bytesDb(database);
  return {
    async read(name) {
      const bytes = await db.get(name);
      return bytes ? { bytes, type: guessMime(safe(name)) ?? "application/octet-stream" } : null;
    },
    write: db.set,
  };
}

export function indexedDbBackupFiles(database: string): BackupFiles {
  const db = bytesDb(database);
  return { list: db.keys, read: db.get, write: db.set };
}
