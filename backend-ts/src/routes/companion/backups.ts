import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BackupFiles } from "@offeru/core";

/** <data>/backups next to offeru.db; writes are atomic (tmp + rename). */
export function nodeBackupFiles(dbFile: string): BackupFiles {
  const dir = join(dirname(dbFile), "backups");
  const safe = (name: string) => /^[0-9a-f]{32}(\.meta)?\.json$/.test(name) ? join(dir, name) : null;
  return {
    async list() {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    },
    async read(name) {
      const path = safe(name);
      if (!path) return null;
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    async write(name, bytes) {
      const path = safe(name);
      if (!path) throw new Error("bad backup file name");
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, bytes);
      await rename(`${path}.tmp`, path);
    },
  };
}
