/**
 * OfferU plugin, browser half.
 *
 * The client mounts the rc8 typed Remote contribution and then projects the
 * read-only Career Context into additive UI slots. It never calls OfferU
 * HTTP, starts a process, or owns business authorization.
 */
window.__ModuleLoader__.load({
	id: "@offeru/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const { useState, useEffect } = react;
		const createElement = react.createElement.bind(react);

		function anySchema(value) {
			return value;
		}

		function stringSchema(value) {
			if (typeof value !== "string") throw new TypeError("expected string");
			return value;
		}

		function integerSchema(value) {
			if (!Number.isSafeInteger(value)) {
				throw new TypeError("expected safe integer");
			}
			return value;
		}

		function recordSchema(value) {
			if (
				value === null ||
				typeof value !== "object" ||
				Array.isArray(value)
			) {
				throw new TypeError("expected object");
			}
			return value;
		}

		const TYPERT_REMOTE = {
			package: "@offeru/dsh-plugin",
			descriptors: [
				{
					id: "@offeru/dsh-plugin#offeru/status",
					service: "offeru",
					namespace: "offeru",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: {
						mode: "strict",
						typeSymbol: "@offeru/dsh-plugin#offeru/status:result",
						schema: { parse: anySchema },
					},
				},
				{
					id: "@offeru/dsh-plugin#offeru/context",
					service: "offeru",
					namespace: "offeru",
					method: "context",
					invocation: { kind: "direct" },
					parameters: [],
					result: {
						mode: "strict",
						typeSymbol: "@offeru/dsh-plugin#offeru/context:result",
						schema: { parse: anySchema },
					},
				},
				{
					id: "@offeru/dsh-plugin#offeru/operations",
					service: "offeru",
					namespace: "offeru",
					method: "operations",
					invocation: { kind: "direct" },
					parameters: [],
					result: {
						mode: "strict",
						typeSymbol: "@offeru/dsh-plugin#offeru/operations:result",
						schema: { parse: anySchema },
					},
				},
				{
					id: "@offeru/dsh-plugin#offeru/events",
					service: "offeru",
					namespace: "offeru",
					method: "events",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "afterSeq",
							wire: "afterSeq",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@offeru/dsh-plugin#afterSeq",
								schema: { parse: integerSchema },
							},
						},
						{
							name: "limit",
							wire: "limit",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@offeru/dsh-plugin#limit",
								schema: { parse: integerSchema },
							},
						},
					],
					result: {
						mode: "strict",
						typeSymbol: "@offeru/dsh-plugin#offeru/events:result",
						schema: { parse: anySchema },
					},
				},
				{
					id: "@offeru/dsh-plugin#offeru/invoke",
					service: "offeru",
					namespace: "offeru",
					method: "invoke",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "operation",
							wire: "operation",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@offeru/dsh-plugin#operation",
								schema: { parse: stringSchema },
							},
						},
						{
							name: "args",
							wire: "args",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@offeru/dsh-plugin#args",
								schema: { parse: recordSchema },
							},
						},
					],
					result: {
						mode: "strict",
						typeSymbol: "@offeru/dsh-plugin#offeru/invoke:result",
						schema: { parse: anySchema },
					},
				},
			],
		};

		async function remoteValue(remote, method, ...args) {
			const result = await remote[method](...args);
			if (!result || result.ok !== true) {
				throw new Error(
					result?.error?.message ||
						"OfferU Remote 调用失败: " + String(method),
				);
			}
			return result.value;
		}

		function OfferULauncher({ remote }) {
			const [status, setStatus] = useState(null);
			useEffect(() => {
				let alive = true;
				const refresh = () =>
					remoteValue(remote, "status")
						.then((next) => alive && setStatus(next))
						.catch(() => alive && setStatus({ running: false }));
				refresh();
				const id = setInterval(refresh, 5000);
				return () => {
					alive = false;
					clearInterval(id);
				};
			}, [remote]);
			return createElement(
				"div",
				{ style: { padding: "4px 8px", fontSize: "12px" } },
				createElement("strong", null, "OfferU"),
				createElement(
					"span",
					{ style: { marginLeft: "6px", opacity: 0.7 } },
					status?.running
						? status.pairedRunId
							? "Run " + status.pairedRunId
							: "bridge ready"
						: "bridge offline",
				),
			);
		}

		function OfferUTaskView({ remote, sessionId }) {
			const [context, setContext] = useState(null);
			const [operations, setOperations] = useState([]);
			const [events, setEvents] = useState([]);
			const [eventCursor, setEventCursor] = useState(0);
			const [error, setError] = useState(null);

			useEffect(() => {
				let alive = true;
				Promise.all([
					remoteValue(remote, "context"),
					remoteValue(remote, "operations"),
				])
					.then(([nextContext, nextOperations]) => {
						if (!alive) return;
						setContext(nextContext);
						setOperations(nextOperations?.operations ?? []);
					})
					.catch((err) => {
						if (alive) setError(String(err.message || err));
					});
				return () => {
					alive = false;
				};
			}, [remote]);

			useEffect(() => {
				let alive = true;
				const refresh = () =>
					remoteValue(remote, "events", eventCursor, 20)
						.then((next) => {
							if (!alive || !Array.isArray(next?.events)) return;
							if (next.events.length === 0) return;
							setEvents((previous) => [...previous, ...next.events].slice(-8));
							setEventCursor(
								Number(next.nextCursor) || eventCursor,
							);
						})
						.catch(() => undefined);
				refresh();
				const id = setInterval(refresh, 2000);
				return () => {
					alive = false;
					clearInterval(id);
				};
			}, [remote, eventCursor]);

			return createElement(
				"div",
				{ style: { padding: "12px" } },
				createElement("h3", null, "OfferU 求职任务视图"),
				context &&
					createElement(
						"div",
						{ style: { marginBottom: "12px", opacity: 0.8 } },
						createElement("strong", null, "Career Context"),
						createElement("div", null, context.goal || "当前 Run 未设置目标"),
						createElement(
							"div",
							{ style: { fontSize: "11px", opacity: 0.7 } },
							"context v" +
								(context.contextVersion ?? "?") +
								" · " +
								(context.skill?.id || "no skill"),
						),
					),
				error &&
					createElement("p", { style: { color: "#c0392b" } }, error),
				operations.length === 0 &&
					!error &&
					createElement("p", null, "未配对或无可用只读 Operation。"),
				createElement(
					"ul",
					null,
					operations.map((op) =>
						createElement(
							"li",
							{ key: op.name },
							op.name,
							" — ",
							op.description || "",
						),
					),
				),
				events.length > 0 &&
					createElement(
						"div",
						{ style: { marginTop: "12px", fontSize: "11px", opacity: 0.7 } },
						createElement("strong", null, "Run events"),
						events.map((event) =>
							createElement(
								"div",
								{ key: event.seq },
								"#" + event.seq + " " + event.type,
							),
						),
					),
				sessionId &&
					createElement(
						"p",
						{ style: { opacity: 0.6 } },
						"session: " + sessionId,
					),
			);
		}

		function OfferUOverlay() {
			return null;
		}

		const inject = ["slots", "remote"];

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			const remote = ctx.remote.offeru;

			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "offeru-launcher",
						order: 100,
						label: "OfferU",
					},
					(props) =>
						createElement(OfferULauncher, { ...props, remote }),
				),
			);
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: "offeru-task-view",
						order: 100,
						label: "OfferU",
					},
					(props) =>
						createElement(OfferUTaskView, { ...props, remote }),
				),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "offeru-overlay",
						order: 100,
						label: "OfferU",
					},
					OfferUOverlay,
				),
			);

			return async () => {
				await disposeRemote();
			};
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
