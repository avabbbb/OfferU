// Node companion wiring for S3 sync: a 0600 JSON config file next to the
// database (credentials + passphrase never enter offeru.db, logs, or the repo)
// and the <data>/files directory as the synced file store.

import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { SyncService, type S3Fetch, type SyncConfig, type SyncConfigStore, type SyncFileInfo, type SyncFileStore, type SyncableStore } from "@offeru/core";

export class JsonFileSyncConfigStore implements SyncConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SyncConfig | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as SyncConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(config: SyncConfig | null): Promise<void> {
    if (!config) {
      await rm(this.path, { force: true });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}

/** A directory as a SyncFileStore ('/'-separated relative paths; dotfiles and *.tmp skipped). */
export class DirSyncFileStore implements SyncFileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private full(path: string): string {
    const target = resolve(this.root, ...path.split("/"));
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new Error(`path escapes the file root: ${path}`);
    return target;
  }

  async list(): Promise<SyncFileInfo[]> {
    const out: SyncFileInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.endsWith(".tmp")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const info = await stat(full);
          out.push({ path: relative(this.root, full).split(sep).join("/"), size: info.size, mtime: info.mtime.toISOString() });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.full(path)));
  }

  async write(path: string, bytes: Uint8Array, mtime?: string): Promise<void> {
    const target = this.full(path);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    if (mtime && Number.isFinite(Date.parse(mtime))) await utimes(target, new Date(), new Date(mtime));
  }

  async remove(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }
}

export function createNodeSyncService(store: SyncableStore, dbFile: string, fetchImpl: S3Fetch = globalThis.fetch as unknown as S3Fetch): SyncService {
  const dataDir = dirname(dbFile);
  return new SyncService({
    store,
    files: new DirSyncFileStore(process.env.OFFERU_FILES_DIR || join(dataDir, "files")),
    config: new JsonFileSyncConfigStore(process.env.OFFERU_SYNC_CONFIG || join(dataDir, "sync-config.json")),
    fetch: fetchImpl,
    defaultDeviceName: hostname().slice(0, 40),
  });
}
