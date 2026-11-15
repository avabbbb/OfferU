// BOSS 直聘 QR login through the bundled `boss` CLI (Node companion only).
// Port of Python app/services/boss_login.py + boss_command/run_boss_json from boss_sync.py.
// OfferU only relays the QR image and progress; the CLI keeps the credential.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { CoreError } from "@offeru/core";

export type BossLoginStatus = "idle" | "starting" | "waiting" | "scanned" | "ok" | "expired" | "error";

export type BossLoginView = {
  installed: boolean;
  status: BossLoginStatus;
  message: string;
  qr: string | null;
  logged_in: boolean | null;
  capabilities: { sync: boolean; search: boolean };
};

const NOT_BUNDLED = "这个版本没有带 boss 命令，请重新安装 OfferU";

/**
 * The bundled boss command. The desktop shell points OFFERU_BOSS_BIN at it.
 * (Python's source-checkout fallback `python backend/boss_entry.py` is not
 * carried over: it goes away with the Python backend.)
 */
export function bossCommand(): string[] | null {
  const bin = process.env.OFFERU_BOSS_BIN;
  return bin ? [bin] : null;
}

function spawnBoss(cmd: string[], args: string[], stderr: "ignore" | "pipe"): ChildProcess {
  return spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ["ignore", "pipe", stderr], windowsHide: true });
}

/** Run `boss <args>` and parse its stdout as JSON. */
export async function runBossJson(args: string[], timeoutSeconds = 90): Promise<Record<string, unknown>> {
  const cmd = bossCommand();
  if (!cmd) throw new CoreError(NOT_BUNDLED);
  const proc = spawnBoss(cmd, args, "pipe");
  proc.stderr?.resume();
  const chunks: Buffer[] = [];
  proc.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<"exit" | "error">((resolve) => {
    proc.once("close", () => resolve("exit"));
    proc.once("error", () => resolve("error"));
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000); });
  const outcome = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    proc.kill();
    throw new CoreError(`boss 命令 ${timeoutSeconds} 秒没有返回`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new CoreError("boss 命令没有输出 JSON");
  }
}

/** One login flow per companion process, like the Python module-level state. */
export class BossLogin {
  private state: { status: BossLoginStatus; message: string } = { status: "idle", message: "" };
  private proc: ChildProcess | null = null;
  private exit: Promise<void> | null = null;

  constructor(private readonly qrPath = join(tmpdir(), "offeru-boss-qr.img")) {}

  private running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private removeQr(): void {
    rmSync(this.qrPath, { force: true });
  }

  /** Only the current process may change state or delete the QR; output from a cancelled one is ignored. */
  private follow(proc: ChildProcess): Promise<void> {
    const lines = createInterface({ input: proc.stdout! });
    lines.on("line", (raw) => {
      if (proc !== this.proc) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const kind = event.event;
      if (kind === "qr") this.state = { status: "waiting", message: "" };
      else if (kind === "scanned") this.state = { status: "scanned", message: "" };
      else if (kind === "ok") this.state = { status: "ok", message: "" };
      else if (kind === "expired") this.state = { status: "expired", message: "二维码过期了" };
      else if (kind === "error") this.state = { status: "error", message: String(event.message || "登录失败") };
    });
    return new Promise<void>((resolve) => {
      const done = () => {
        if (proc === this.proc) {
          if (["starting", "waiting", "scanned"].includes(this.state.status)) {
            this.state = { status: "error", message: "登录进程意外退出" };
          }
          this.removeQr();
        }
        resolve();
      };
      proc.once("close", done);
      proc.once("error", done);
    });
  }

  async view(): Promise<BossLoginView> {
    const installed = bossCommand() !== null;
    const view: BossLoginView = {
      installed, ...this.state, qr: null, logged_in: null, capabilities: { sync: false, search: false },
    };
    if ((this.state.status === "waiting" || this.state.status === "scanned") && existsSync(this.qrPath)) {
      const image = readFileSync(this.qrPath);
      const kind = image[0] === 0xff && image[1] === 0xd8 ? "jpeg" : "png";
      view.qr = `data:image/${kind};base64,${image.toString("base64")}`;
    }
    if (!this.running() && installed) {
      let status: Record<string, unknown> = {};
      try {
        status = await runBossJson(["status", "--json"], 20);
      } catch {
        status = {};
      }
      view.logged_in = Boolean(status.credential_present);
      view.capabilities = { sync: view.logged_in, search: view.logged_in && Boolean(status.search_authenticated) };
    }
    return view;
  }

  async start(): Promise<BossLoginView> {
    if (this.running()) return this.view();
    const cmd = bossCommand();
    if (!cmd) throw new CoreError(NOT_BUNDLED);
    this.removeQr();
    this.state = { status: "starting", message: "" };
    const proc = spawnBoss(cmd, ["login-qr", this.qrPath], "ignore");
    this.proc = proc;
    this.exit = this.follow(proc);
    return this.view();
  }

  async cancel(): Promise<BossLoginView> {
    if (this.running()) {
      this.proc!.kill();
      await this.exit;
    }
    this.state = { status: "idle", message: "" };
    return this.view();
  }

  async logout(): Promise<BossLoginView> {
    await this.cancel();
    await runBossJson(["logout"], 20);
    return this.view();
  }
}
