/**
 * OfferU plugin, host half (node side).
 *
 * The host owns the local Agent Bridge and exposes:
 *   1. a typed rc8 Remote Service for the browser client;
 *   2. three model-facing, read-only OfferU tools.
 *
 * The browser half never talks to OfferU HTTP/DB directly. Mutations and
 * proposal confirmation are deliberately outside this Slice-2 tracer.
 */
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const BRIDGE_PROTOCOL = 1;
const MAX_LINE_BYTES = 1 << 20;
const BRIDGE_VERSION = "0.1.0-rc.8";
const ADAPTER_VERSION = "0.1.0";

const argsSpec = {
	arguments: {
		type: "object",
		additionalProperties: true,
		description:
			"Operation arguments object; pass {} when the operation takes no parameters.",
	},
};

var __runInitializers = function (thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) {
		value = useValue
			? initializers[i].call(thisArg, value)
			: initializers[i].call(thisArg);
	}
	return useValue ? value : void 0;
};

var __esDecorate = function (
	ctor,
	descriptorIn,
	decorators,
	contextIn,
	initializers,
	extraInitializers,
) {
	function accept(value) {
		if (value !== void 0 && typeof value !== "function") {
			throw new TypeError("Function expected");
		}
		return value;
	}
	const kind = contextIn.kind;
	const key =
		kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	const target =
		!descriptorIn && ctor
			? contextIn.static
				? ctor
				: ctor.prototype
			: null;
	const descriptor =
		descriptorIn ||
		(target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	let replacement;
	let done = false;
	for (let i = decorators.length - 1; i >= 0; i--) {
		const context = {};
		for (const property in contextIn) {
			context[property] =
				property === "access" ? {} : contextIn[property];
		}
		for (const property in contextIn.access) {
			context.access[property] = contextIn.access[property];
		}
		context.addInitializer = (initializer) => {
			if (done) {
				throw new TypeError(
					"Cannot add initializers after decoration has completed",
				);
			}
			extraInitializers.push(accept(initializer || null));
		};
		const result = decorators[i](
			kind === "accessor"
				? { get: descriptor.get, set: descriptor.set }
				: descriptor[key],
			context,
		);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") {
				throw new TypeError("Object expected");
			}
			if ((replacement = accept(result.get)) !== void 0) {
				descriptor.get = replacement;
			}
			if ((replacement = accept(result.set)) !== void 0) {
				descriptor.set = replacement;
			}
			if ((replacement = accept(result.init)) !== void 0) {
				initializers.unshift(replacement);
			}
		} else if ((replacement = accept(result)) !== void 0) {
			if (kind === "field") initializers.unshift(replacement);
			else descriptor[key] = replacement;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

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
		this.contextVersion = 0;
		this.sessionSeed = Math.random().toString(16).slice(2, 8);
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
		this.proc.stderr.on("data", () => {});
		this.proc.on("exit", (code) => {
			this.proc = null;
			this.helloDone = false;
			this.pairedRunId = null;
			this.leaseId = null;
			for (const { reject } of this.pending.values()) {
				reject(new Error("bridge exited code=" + String(code)));
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
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const pending = this.pending.get(message.id);
			if (pending) {
				this.pending.delete(message.id);
				pending.resolve(message);
			}
		}
	}

	request(type, payload = {}, envelope = {}) {
		if (!this.proc) this.start();
		const id = String(this.nextId++);
		const body =
			JSON.stringify({ v: BRIDGE_PROTOCOL, type, id, payload, ...envelope }) +
			"\n";
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
			harness: { name: "deepseek-harness", version: BRIDGE_VERSION },
			adapter: { name: "@offeru/dsh-plugin", version: ADAPTER_VERSION },
		});
		if (!res.ok) throw new Error("bridge hello failed: " + res.error?.code);
		this.helloDone = true;
	}

	async pair(bootstrapToken) {
		await this.hello();
		const res = await this.request("pairing.request", { bootstrapToken });
		if (!res.ok) throw new Error("pairing failed: " + res.error?.code);
		this.pairedRunId = res.result.runId;
		return res.result;
	}

	async attach(sessionId) {
		const res = await this.request(
			"run.attach",
			{
				harnessSessionId:
					sessionId ||
					process.env.OFFERU_DSH_SESSION_ID ||
					"offeru-dsh-session",
				lastEventSeq: 0,
				harness: { name: "deepseek-harness", version: BRIDGE_VERSION },
				adapter: { name: "@offeru/dsh-plugin", version: ADAPTER_VERSION },
			},
			{ runId: this.pairedRunId },
		);
		if (!res.ok) throw new Error("attach failed: " + res.error?.code);
		this.leaseId = res.result.leaseId;
		this.contextVersion = res.result.contextVersion ?? 0;
		return res.result;
	}

	async contextSnapshot() {
		const res = await this.request(
			"context.snapshot",
			{},
			{ runId: this.pairedRunId },
		);
		if (!res.ok) {
			throw new Error("context.snapshot failed: " + res.error?.code);
		}
		this.contextVersion = res.result.contextVersion ?? this.contextVersion;
		return res.result;
	}

	async operations() {
		const res = await this.request(
			"operation.list",
			{},
			{ runId: this.pairedRunId },
		);
		if (!res.ok) {
			throw new Error("operation.list failed: " + res.error?.code);
		}
		return res.result.operations;
	}

	async events(afterSeq, limit) {
		const res = await this.request(
			"event.follow",
			{ afterSeq, limit },
			{ runId: this.pairedRunId },
		);
		if (!res.ok) throw new Error("event.follow failed: " + res.error?.code);
		return res.result;
	}

	async invoke(operation, args) {
		this.invokeSeq = (this.invokeSeq ?? 0) + 1;
		const res = await this.request(
			"operation.invoke",
			{
				operation,
				arguments: args ?? {},
				idempotencyKey: "dsh-" + this.sessionSeed + "-" + this.invokeSeq,
				contextVersion: this.contextVersion,
			},
			{ runId: this.pairedRunId },
		);
		if (!res.ok) throw new Error(operation + " failed: " + res.error?.code);
		return res.result;
	}
}

function toolOutput(value, limit = 6000) {
	const text = JSON.stringify(value) ?? String(value);
	return [{ type: "text", text: text.slice(0, limit) }];
}

function registerReadOnlyTools(service) {
	const ctx = service.ctx;
	ctx.tools.register(
		defineTool({
			name: "offeru_context",
			description:
				"读取当前 OfferU Run 的最小职业上下文、任务、Skill、上下文版本和已授权只读能力。不要假设这里包含完整 JD 或完整简历。",
			parameters: {},
			output: {
				schema: { type: "json" },
				render: (_args, value) => toolOutput(value),
			},
			async execute() {
				return service.context();
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "offeru_operations",
			description:
				"列出当前 OfferU Run 被授予的只读 Operation 及其实时参数 schema。只能使用返回列表中的 Operation。",
			parameters: {},
			output: {
				schema: { type: "json" },
				render: (_args, value) => toolOutput(value),
			},
			async execute() {
				return service.operations();
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "offeru_run",
			description:
				"通过 OfferU Agent Bridge 执行一个当前 Run 已授权的只读 Operation。不会写入业务状态、不会提交 proposal、不会访问 shell/文件/网络。",
			parameters: {
				operation: {
					type: "string",
					required: true,
					description: "来自 offeru_operations 的 Operation 名称",
				},
				arguments: argsSpec.arguments,
			},
			output: {
				schema: { type: "json" },
				render: (_args, value) => toolOutput(value),
			},
			async execute(args) {
				return service.invoke(args.operation, args.arguments ?? {});
			},
		}),
	);
}

let OfferUService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _status_decorators;
	let _context_decorators;
	let _operations_decorators;
	let _events_decorators;
	let _invoke_decorators;
	return class OfferUService extends _classSuper {
		static {
			const _metadata =
				typeof Symbol === "function" && Symbol.metadata
					? Object.create(_classSuper[Symbol.metadata] ?? null)
					: void 0;
			_status_decorators = [Remote("status")];
			_context_decorators = [Remote("context")];
			_operations_decorators = [Remote("operations")];
			_events_decorators = [Remote("events")];
			_invoke_decorators = [Remote("invoke")];
			__esDecorate(
				this,
				null,
				_status_decorators,
				{
					kind: "method",
					name: "status",
					static: false,
					private: false,
					access: {
						has: (obj) => "status" in obj,
						get: (obj) => obj.status,
					},
					metadata: _metadata,
				},
				null,
				_instanceExtraInitializers,
			);
			__esDecorate(
				this,
				null,
				_context_decorators,
				{
					kind: "method",
					name: "context",
					static: false,
					private: false,
					access: {
						has: (obj) => "context" in obj,
						get: (obj) => obj.context,
					},
					metadata: _metadata,
				},
				null,
				_instanceExtraInitializers,
			);
			__esDecorate(
				this,
				null,
				_operations_decorators,
				{
					kind: "method",
					name: "operations",
					static: false,
					private: false,
					access: {
						has: (obj) => "operations" in obj,
						get: (obj) => obj.operations,
					},
					metadata: _metadata,
				},
				null,
				_instanceExtraInitializers,
			);
			__esDecorate(
				this,
				null,
				_events_decorators,
				{
					kind: "method",
					name: "events",
					static: false,
					private: false,
					access: {
						has: (obj) => "events" in obj,
						get: (obj) => obj.events,
					},
					metadata: _metadata,
				},
				null,
				_instanceExtraInitializers,
			);
			__esDecorate(
				this,
				null,
				_invoke_decorators,
				{
					kind: "method",
					name: "invoke",
					static: false,
					private: false,
					access: {
						has: (obj) => "invoke" in obj,
						get: (obj) => obj.invoke,
					},
					metadata: _metadata,
				},
				null,
				_instanceExtraInitializers,
			);
			if (_metadata) {
				Object.defineProperty(this, Symbol.metadata, {
					enumerable: true,
					configurable: true,
					writable: true,
					value: _metadata,
				});
			}
		}

		static inject = ["tools"];

		constructor(ctx) {
			super(ctx, "offeru");
			__runInitializers(this, _instanceExtraInitializers);
			this.backendCwd =
				process.env.OFFERU_BACKEND_DIR ||
				"H:/WorkSpace_For_VsCode/Python/OFFERU/backend";
			this.bridge = new BridgeClient(this.backendCwd);
			this.bootstrapToken = process.env.OFFERU_BRIDGE_TOKEN || "";
			this.attachPromise = null;

			ctx.effect(
				() => {
					this.bridge.start();
					return () => this.bridge.stop();
				},
				"offeru: bridge",
			);
			registerReadOnlyTools(this);

			if (!this.bootstrapToken) {
				ctx.logger?.warn?.(
					"OfferU plugin: no OFFERU_BRIDGE_TOKEN; the read-only bridge remains unpaired.",
				);
			} else {
				void this.ensureAttached().catch((error) => {
					ctx.logger?.warn?.(
						"OfferU plugin: pairing/attach failed: " +
							(error?.message || String(error)),
					);
				});
			}
		}

		async ensureAttached() {
			if (this.bridge.pairedRunId && this.bridge.leaseId) return;
			if (!this.bootstrapToken) {
				throw new Error(
					"OfferU pairing requires OFFERU_BRIDGE_TOKEN for this local profile",
				);
			}
			if (this.attachPromise === null) {
				this.attachPromise = (async () => {
					if (!this.bridge.pairedRunId) {
						await this.bridge.pair(this.bootstrapToken);
					}
					if (!this.bridge.leaseId) await this.bridge.attach();
				})().catch((error) => {
					this.attachPromise = null;
					throw error;
				});
			}
			await this.attachPromise;
		}

		async status() {
			return {
				running: this.bridge.proc !== null,
				bootstrapConfigured: this.bootstrapToken !== "",
				pairedRunId: this.bridge.pairedRunId,
				helloDone: this.bridge.helloDone,
				leaseId: this.bridge.leaseId,
				contextVersion: this.bridge.contextVersion,
			};
		}

		async context() {
			await this.ensureAttached();
			return this.bridge.contextSnapshot();
		}

		async operations() {
			await this.ensureAttached();
			return { operations: await this.bridge.operations() };
		}

		async events(afterSeq, limit) {
			await this.ensureAttached();
			const cursor = Number.isSafeInteger(afterSeq) ? afterSeq : 0;
			const count =
				Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
			return this.bridge.events(cursor, count);
		}

		async invoke(operation, args) {
			await this.ensureAttached();
			const operations = await this.bridge.operations();
			if (!operations.some((candidate) => candidate.name === operation)) {
				throw new Error(
					"OfferU Operation 未获当前 Run 授权: " + String(operation),
				);
			}
			return this.bridge.invoke(operation, args ?? {});
		}
	};
})();

export { OfferUService, OfferUService as default };
