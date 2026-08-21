/**
 * OfferU plugin, host half (node side).
 *
 * Starts `offeru bridge --stdio` (Slice 1 read-only Agent Bridge) as a child
 * process, speaks the v1 JSONL envelope over its stdin/stdout, and exposes
 * Package-private RPCs to the browser half via harness.handle:
 *
 *   offeru.status      → bridge process + pairing state
 *   offeru.pair        → one-shot pairing with bootstrap token, then attach
 *   offeru.operations  → granted operation list (from Bridge)
 *   offeru.invoke      → { operation, arguments } read-only invoke
 *
 * The browser half never talks to OfferU HTTP/DB directly (ADR-0055): all
 * reads funnel through this host half over the typed host/client channel.
 */
import { spawn } from "node:child_process";

const BRIDGE_PROTOCOL = 1;
const MAX_LINE_BYTES = 1 << 20;

function resolveBridgeCommand() {
	const python =
		process.env.OFFERU_PYTHON ||
		"H:/WorkSpace_For_VsCode/Python/OFFERU/backend/.venv312/Scripts/python.exe";
	return { cmd: python, args: ["-m", "app.bridge_cli", "stdio"] };
}

class BridgeClient {
	constructor(cwd) {
		this.cwd = cwd;
		this.proc = null;
		this.buffer = "";
		this.nextId = 1;
		this.pending = new Map();
		this.helloDone = false;
		this.pairedRunId = null;
		this.leaseId = null;
	}

	start() {
		if (this.proc) return;
		const { cmd, args } = resolveBridgeCommand();
		this.proc = spawn(cmd, args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this._onData(chunk));
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", () => {}); // diagnostics only; never echoed to stdout
		this.proc.on("exit", (code) => {
			this.proc = null;
			this.helloDone = false;
			for (const { reject } of this.pending.values()) {
				reject(new Error(`bridge exited code=${code}`));
			}
			this.pending.clear();
		});
	}

	stop() {
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}
	}

	_onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx < 0 || idx > MAX_LINE_BYTES) break;
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // stdout noise is dropped, per wire contract
			}
			const pending = this.pending.get(msg.id);
			if (pending) {
				this.pending.delete(msg.id);
				pending.resolve(msg);
			}
		}
	}

	request(type, payload = {}) {
		if (!this.proc) this.start();
		const id = String(this.nextId++);
		const body = JSON.stringify({ v: BRIDGE_PROTOCOL, type, id, payload }) + "\n";
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(body, () => undefined);
		});
	}

	async hello() {
		if (this.helloDone) return;
		const res = await this.request("hello", {
			protocols: [BRIDGE_PROTOCOL],
			capabilities: {
				sessionResume: true,
				steer: true,
				interrupt: true,
				toolSuspendResume: false,
				eventStream: true,
				workspaceIsolation: "run-dir",
				nativeClient: false,
			},
			harness: { name: "deepseek-harness", version: "0.1.0-rc.8" },
			adapter: { name: "@offeru/dsh-plugin", version: "0.1.0" },
		});
		if (!res.ok) throw new Error(`bridge hello failed: ${res.error?.code}`);
		this.helloDone = true;
	}

	async pair(bootstrapToken) {
		await this.hello();
		const res = await this.request("pairing.request", { bootstrapToken });
		if (!res.ok) throw new Error(`pairing failed: ${res.error?.code}`);
		this.pairedRunId = res.result.runId;
		return res.result;
	}

	async attach(harnessSessionId) {
		const res = await this.request("run.attach", {
			harnessSessionId,
			lastEventSeq: 0,
			harness: { name: "deepseek-harness", version: "0.1.0-rc.8" },
			adapter: { name: "@offeru/dsh-plugin", version: "0.1.0" },
		});
		if (!res.ok) throw new Error(`attach failed: ${res.error?.code}`);
		this.leaseId = res.result.leaseId;
		return res.result;
	}

	async operations() {
		await this.hello();
		const res = await this.request("operation.list", {});
		if (!res.ok) throw new Error(`operation.list failed: ${res.error?.code}`);
		return res.result.operations;
	}

	async invoke(operation, args) {
		const res = await this.request("operation.invoke", {
			operation,
			arguments: args ?? {},
		});
		if (!res.ok) throw new Error(`${operation} failed: ${res.error?.code}`);
		return res.result;
	}
}

/** Host plugin body — owns the Bridge child process and its RPC surface. */
export function apply(ctx) {
	const backendCwd =
		process.env.OFFERU_BACKEND_DIR ||
		"H:/WorkSpace_For_VsCode/Python/OFFERU/backend";
	const bridge = new BridgeClient(backendCwd);

	ctx.effect?.(() => {
		bridge.start();
		return () => bridge.stop();
	});

	// Package-private Client→Host RPCs. Lossless JSON in and out.
	ctx.harness?.handle?.("offeru.status", async () => ({
		running: bridge.proc !== null,
		pairedRunId: bridge.pairedRunId,
		helloDone: bridge.helloDone,
	}));

	ctx.harness?.handle?.("offeru.pair", async ({ bootstrapToken }) => {
		const result = await bridge.pair(bootstrapToken);
		try {
			const attachResult = await bridge.attach("offeru-dsh-session");
			return { ...result, attached: true, leaseId: attachResult.leaseId };
		} catch (err) {
			return { ...result, attached: false, error: String(err.message || err) };
		}
	});

	ctx.harness?.handle?.("offeru.operations", async () => bridge.operations());

	ctx.harness?.handle?.("offeru.invoke", async ({ operation, arguments: args }) =>
		bridge.invoke(operation, args),
	);
}
