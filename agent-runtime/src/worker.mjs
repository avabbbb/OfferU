import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = "offeru.pi-worker.v1";
const SDK_VERSION = "0.84.4";
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 120_000;

let inputBuffer = "";
let activeRun = null;
let shuttingDown = false;
const pendingOperations = new Map();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, command, success, data = undefined, error = undefined) {
  writeMessage({
    type: "response",
    id,
    command,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  });
}

function emit(event, payload = {}, runId = activeRun?.runId) {
  writeMessage({
    type: "event",
    event,
    ...(runId ? { run_id: runId } : {}),
    payload,
  });
}

function safeError(error, secret = "") {
  const raw = error instanceof Error ? error.message : String(error || "Unknown worker error");
  return secret ? raw.split(secret).join("<redacted>") : raw;
}

function createResourceLoader(systemPrompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function operationSchema(operations) {
  const names = operations.map((item) => item.name);
  const operationType = names.length === 1
    ? Type.Literal(names[0])
    : Type.Union(names.map((name) => Type.Literal(name)));
  return Type.Object({
    operation: operationType,
    arguments: Type.Record(Type.String(), Type.Unknown()),
  });
}

function describeOperations(operations) {
  return operations
    .map((item) => `- ${item.name}: ${item.description || "OfferU operation"}`)
    .join("\n");
}

function createOperationTool(runId, operations) {
  const allowed = new Set(operations.map((item) => item.name));
  return defineTool({
    name: "offeru_operation",
    label: "OfferU Operation",
    description: "Call one task-scoped OfferU Operation. Python enforces schema, confirmation, audit and idempotency.",
    parameters: operationSchema(operations),
    execute: async (_toolCallId, params, signal) => {
      if (!allowed.has(params.operation)) {
        throw new Error(`Operation is outside this Run grant: ${params.operation}`);
      }
      const requestId = `op_${randomUUID()}`;
      emit("operation.requested", {
        request_id: requestId,
        operation: params.operation,
        arguments: params.arguments,
      }, runId);

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingOperations.delete(requestId);
          reject(new Error(`Operation bridge timed out: ${params.operation}`));
        }, OPERATION_TIMEOUT_MS);
        const abort = () => {
          clearTimeout(timer);
          pendingOperations.delete(requestId);
          reject(new Error(`Operation bridge aborted: ${params.operation}`));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pendingOperations.set(requestId, {
          runId,
          resolve: (value) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        });
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { operation: params.operation, requestId },
      };
    },
  });
}

async function createRunSession(command) {
  const provider = command.provider || {};
  const operations = Array.isArray(command.allowed_operations) ? command.allowed_operations : [];
  const sessionSpec = command.session || {};
  if (!command.run_id || !provider.model || !provider.base_url || !provider.api_key) {
    throw new Error("run.start requires run_id and complete provider configuration");
  }
  if (operations.length === 0 || operations.some((item) => !item?.name)) {
    throw new Error("run.start requires at least one named allowed Operation");
  }
  if (sessionSpec.mode === "resume" && !sessionSpec.file) {
    throw new Error("run.start resume requires a session file");
  }
  if (sessionSpec.mode !== "resume" && !sessionSpec.directory) {
    throw new Error("run.start create requires a session directory");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(command.run_id)) {
    throw new Error("run.start received an invalid run_id");
  }

  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const providerId = "offeru-active";
  modelRuntime.registerProvider(providerId, {
    name: provider.name || "OfferU active provider",
    baseUrl: provider.base_url,
    api: "openai-completions",
    authHeader: true,
    models: [{
      id: provider.model,
      name: provider.model,
      reasoning: Boolean(provider.reasoning),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(provider.context_window || 128_000),
      maxTokens: Number(provider.max_tokens || 4096),
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        ...(provider.compat || {}),
      },
    }],
  });
  await modelRuntime.setRuntimeApiKey(providerId, provider.api_key);
  const model = modelRuntime.getModel(providerId, provider.model);
  if (!model) throw new Error(`Pi could not register model: ${provider.model}`);

  const systemPrompt = `${command.system_prompt || "You are the OfferU main Agent."}\n\n` +
    "You have no shell or filesystem tools. Use offeru_operation only when the task requires product data or an action. " +
    "Never claim a mutation happened when the Operation result says it is only proposed or requires confirmation.\n\n" +
    `Run-scoped Operations:\n${describeOperations(operations)}`;
  const operationTool = createOperationTool(command.run_id, operations);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  let sessionManager;
  if (sessionSpec.mode === "resume") {
    sessionManager = SessionManager.open(
      sessionSpec.file,
      sessionSpec.directory || undefined,
      process.cwd(),
    );
  } else {
    const sessionDirectory = resolve(sessionSpec.directory);
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, `${command.run_id}.jsonl`);
    writeFileSync(sessionFile, "", { flag: "wx" });
    sessionManager = SessionManager.open(
      sessionFile,
      sessionDirectory,
      process.cwd(),
    );
  }
  if (sessionSpec.mode !== "resume") {
    sessionManager.appendCustomEntry("offeru.run", {
      run_id: command.run_id,
      protocol_version: PROTOCOL_VERSION,
    });
  }
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    model,
    modelRuntime,
    thinkingLevel: provider.thinking_level || "medium",
    noTools: "builtin",
    tools: ["offeru_operation"],
    customTools: [operationTool],
    resourceLoader: createResourceLoader(systemPrompt),
    sessionManager,
    settingsManager,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      emit("message.delta", { delta: event.assistantMessageEvent.delta }, command.run_id);
      return;
    }
    const forwarded = new Set([
      "agent_start",
      "agent_end",
      "agent_settled",
      "turn_start",
      "turn_end",
      "tool_execution_start",
      "tool_execution_end",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
    ]);
    if (forwarded.has(event.type)) {
      emit(`pi.${event.type}`, {}, command.run_id);
    }
  });

  return {
    runId: command.run_id,
    session,
    unsubscribe,
    apiKey: provider.api_key,
    sdkVersion: SDK_VERSION,
    sessionFile: sessionManager.getSessionFile(),
  };
}

async function disposeActiveRun() {
  if (!activeRun) return;
  const current = activeRun;
  activeRun = null;
  for (const [requestId, pending] of pendingOperations) {
    if (pending.runId === current.runId) {
      pendingOperations.delete(requestId);
      pending.reject(new Error("Run disposed before Operation completed"));
    }
  }
  current.unsubscribe?.();
  current.session.dispose();
  emit("run.disposed", {}, current.runId);
}

async function handleCommand(command) {
  const id = command?.id;
  const type = command?.type;
  if (!id || !type) {
    response(id || null, type || "unknown", false, undefined, "Every command requires id and type");
    return;
  }
  try {
    if (type === "runtime.probe") {
      response(id, type, true, {
        protocol_version: PROTOCOL_VERSION,
        sdk_version: SDK_VERSION,
        node_version: process.versions.node,
        lifecycle: "application_worker_single_active_run",
        session_scope: "one_pi_session_per_offeru_agent_run",
        session_persistence: "run_scoped_jsonl",
        built_in_tools: "disabled_for_run_sessions",
      });
      return;
    }
    if (type === "run.start") {
      if (activeRun) throw new Error(`Worker already owns active Run ${activeRun.runId}`);
      activeRun = await createRunSession(command);
      emit("run.started", {
        session_id: activeRun.session.sessionId,
        sdk_version: SDK_VERSION,
        active_tools: activeRun.session.getActiveToolNames(),
      }, activeRun.runId);
      response(id, type, true, {
        run_id: activeRun.runId,
        session_id: activeRun.session.sessionId,
        sdk_version: activeRun.sdkVersion,
        session_file: activeRun.sessionFile,
        active_tools: activeRun.session.getActiveToolNames(),
      });
      return;
    }
    if (type === "run.prompt") {
      if (!activeRun || activeRun.runId !== command.run_id) throw new Error("Run is not active in this Worker");
      await activeRun.session.prompt(String(command.message || ""));
      response(id, type, true, {
        run_id: activeRun.runId,
        session_id: activeRun.session.sessionId,
        assistant_message: activeRun.session.getLastAssistantText() || "",
      });
      return;
    }
    if (type === "operation.result") {
      const pending = pendingOperations.get(command.request_id);
      if (!pending || pending.runId !== command.run_id) throw new Error("Operation request is not pending for this Run");
      pendingOperations.delete(command.request_id);
      pending.resolve(command.result);
      response(id, type, true, { request_id: command.request_id });
      return;
    }
    if (type === "run.abort") {
      if (!activeRun || activeRun.runId !== command.run_id) throw new Error("Run is not active in this Worker");
      await activeRun.session.abort();
      emit("run.aborted", {}, activeRun.runId);
      response(id, type, true, { run_id: activeRun.runId });
      return;
    }
    if (type === "run.dispose") {
      if (!activeRun || activeRun.runId !== command.run_id) throw new Error("Run is not active in this Worker");
      await disposeActiveRun();
      response(id, type, true, { run_id: command.run_id });
      return;
    }
    if (type === "shutdown") {
      shuttingDown = true;
      await disposeActiveRun();
      response(id, type, true, { stopped: true });
      process.exitCode = 0;
      process.stdin.pause();
      return;
    }
    throw new Error(`Unknown command: ${type}`);
  } catch (error) {
    response(id, type, false, undefined, safeError(error, activeRun?.apiKey));
  }
}

function acceptChunk(chunk) {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer, "utf8") > MAX_INPUT_BYTES) {
    emit("runtime.fatal", { error: "Input record exceeded protocol limit" });
    process.exitCode = 1;
    process.stdin.pause();
    return;
  }
  let newline = inputBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = inputBuffer.slice(0, newline).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.trim()) {
      try {
        const command = JSON.parse(line);
        void handleCommand(command);
      } catch (error) {
        response(null, "invalid_json", false, undefined, safeError(error));
      }
    }
    newline = inputBuffer.indexOf("\n");
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", acceptChunk);
process.stdin.on("end", async () => {
  if (!shuttingDown) await disposeActiveRun();
});
process.on("uncaughtException", (error) => {
  emit("runtime.fatal", { error: safeError(error, activeRun?.apiKey) });
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  emit("runtime.fatal", { error: safeError(error, activeRun?.apiKey) });
  process.exitCode = 1;
});

emit("runtime.ready", {
  protocol_version: PROTOCOL_VERSION,
  sdk_version: SDK_VERSION,
  node_version: process.versions.node,
});
