/**
 * OfferU plugin, browser half.
 *
 * Loaded by @deepseek-ai/dsh-client-modules through the dsh.client manifest
 * (./client export), served at /plugins/@offeru/dsh-plugin/client.js and
 * registered via window.__ModuleLoader__.load — same contract as the shipped
 * @deepseek-ai/dsh-client-ui-brand-official package.
 *
 * Registers three additive surfaces per ADR-0055 / Slice 2:
 *   1. sidebar.footer.action      — fixed OfferU launcher entry
 *   2. conversation.view          — session-scoped task view (Run mirror)
 *   3. shell.overlay              — pairing surface (approvals arrive Slice 3)
 *
 * All data comes from the host half via host.call; no direct HTTP to OfferU.
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

		async function callHost(method, args) {
			return host.call(method, args);
		}

		function OfferULauncher() {
			const [status, setStatus] = useState(null);
			useEffect(() => {
				let alive = true;
				const refresh = () =>
					callHost("offeru.status", {})
						.then((s) => alive && setStatus(s))
						.catch(() => alive && setStatus({ running: false }));
				refresh();
				const id = setInterval(refresh, 5000);
				return () => {
					alive = false;
					clearInterval(id);
				};
			}, []);
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

		function OfferUTaskView(props) {
			const [operations, setOperations] = useState([]);
			const [error, setError] = useState(null);
			useEffect(() => {
				callHost("offeru.operations", {})
					.then((ops) => setOperations(ops))
					.catch((err) => setError(String(err.message || err)));
			}, []);
			return createElement(
				"div",
				{ style: { padding: "12px" } },
				createElement("h3", null, "OfferU 求职任务视图"),
				error &&
					createElement("p", { style: { color: "#c0392b" } }, error),
				operations.length === 0 &&
					!error &&
					createElement("p", null, "未配对或无可用 Operation。先在工作台生成配对令牌。"),
				createElement(
					"ul",
					null,
					operations.map((op) =>
						createElement("li", { key: op.name }, op.name, " — ", op.description || ""),
					),
				),
				props?.sessionId &&
					createElement("p", { style: { opacity: 0.6 } }, "session: " + props.sessionId),
			);
		}

		function OfferUOverlay() {
			return null; // Slice 2 read-only tracer; Slice 3 mounts approval UI here.
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Fill the three additive surfaces as one declaration-aware registration set.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.inject("conversation.view", () =>
					ctx.slots.inject("shell.overlay", function* () {
						yield ctx.slots.register(
							{ name: "sidebar.footer.action", id: "offeru-launcher" },
							OfferULauncher,
						);
						yield ctx.slots.register(
							{ name: "conversation.view", id: "offeru-task-view" },
							OfferUTaskView,
						);
						yield ctx.slots.register(
							{ name: "shell.overlay", id: "offeru-overlay" },
							OfferUOverlay,
						);
					}),
				),
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
