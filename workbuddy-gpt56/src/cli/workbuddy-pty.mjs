import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8780";
const DEFAULT_MODEL_ID = "custom-local:gpt-5.6-sol";
const DEFAULT_POLL_MS = 500;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function parseArgs(argv) {
  const options = {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    modelId: DEFAULT_MODEL_ID,
    resumeSessionId: "",
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    initialPrompt: "",
  };
  const promptParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bridge") options.bridgeUrl = String(argv[++index] || "").trim();
    else if (arg === "--model") options.modelId = String(argv[++index] || "").trim();
    else if (arg === "--resume") options.resumeSessionId = String(argv[++index] || "").trim();
    else if (arg === "--poll-ms") options.pollMs = positiveInteger(argv[++index], DEFAULT_POLL_MS);
    else if (arg === "--timeout-ms") options.timeoutMs = positiveInteger(argv[++index], DEFAULT_TURN_TIMEOUT_MS);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new Error(`未知参数: ${arg}`);
    else promptParts.push(arg);
  }
  if (!options.bridgeUrl) throw new Error("--bridge 不能为空");
  if (!options.modelId) throw new Error("--model 不能为空");
  if (argv.includes("--resume") && !options.resumeSessionId) throw new Error("--resume 需要会话 ID");
  options.bridgeUrl = options.bridgeUrl.replace(/\/+$/u, "");
  options.initialPrompt = promptParts.join(" ").trim();
  return options;
}

export function helpText() {
  return [
    "WorkBuddy PTY bridge",
    "",
    "用法: codebuddy [--bridge URL] [--model MODEL_ID] [--resume SESSION_ID] [首条指令]",
    "",
    `默认桥接: ${DEFAULT_BRIDGE_URL}`,
    `默认模型: ${DEFAULT_MODEL_ID}`,
  ].join("\n");
}

async function parseJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`桥接返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `桥接请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export class BridgeClient {
  constructor(baseUrl, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 不支持 fetch");
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = fetchImpl;
  }

  async request(route, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new Error(`无法连接 WorkBuddy 桥接 ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseJsonResponse(response);
  }

  async createSession(cwd, text, modelId) {
    return this.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ cwd, text, modelId }),
    });
  }

  async getSession(sessionId) {
    return this.request(`/api/tasks/${encodeURIComponent(sessionId)}`);
  }

  async setModel(sessionId, modelId) {
    return this.request(`/api/tasks/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: JSON.stringify({ modelId }),
    });
  }

  async sendMessage(sessionId, text) {
    return this.request(`/api/tasks/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async getMessageDispatch(dispatchId) {
    return this.request(`/api/message-dispatches/${encodeURIComponent(dispatchId)}`);
  }
}

async function directoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function findSessionJsonl(sessionId, homeDir = os.homedir()) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  for (const hiddenRoot of [".workbuddy", ".codebuddy"]) {
    const projectsRoot = path.join(homeDir, hiddenRoot, "projects");
    for (const entry of await directoryEntries(projectsRoot)) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsRoot, entry.name, `${id}.jsonl`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
    }
  }
  return "";
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && ["output_text", "text"].includes(block.type))
    .map((block) => String(block.text || ""))
    .join("");
}

function errorText(event) {
  return String(
    event?.providerData?.error?.message ||
    event?.error?.message ||
    event?.error ||
    contentText(event?.content) ||
    "WorkBuddy 回合未完成"
  ).trim();
}

export function classifyJsonlEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "function_call") {
    const name = String(event.name || "");
    if (["askuserquestion", "ask_user_question", "request_user_input", "requestuserinput"].includes(name.toLowerCase())) {
      return { kind: "needs-user", text: `WorkBuddy 正在等待交互：${name}` };
    }
    return null;
  }
  if (event.type !== "message" || event.role !== "assistant") return null;
  if (event.status === "completed") return { kind: "completed", text: contentText(event.content).trim() };
  if (["incomplete", "failed", "error", "cancelled", "canceled", "aborted"].includes(String(event.status || "").toLowerCase())) {
    return { kind: "incomplete", text: errorText(event) };
  }
  return null;
}

export function inspectJsonlText(raw) {
  let lastUserIndex = -1;
  let lastUserId = "";
  let terminal = null;
  let needsUser = null;
  const lines = String(raw || "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (event?.type === "message" && event?.role === "user") {
      lastUserIndex = index;
      lastUserId = String(event.id || event.messageId || event.timestamp || index);
      terminal = null;
      needsUser = null;
      continue;
    }
    if (lastUserIndex < 0 || index <= lastUserIndex) continue;
    const classified = classifyJsonlEvent(event);
    if (classified?.kind === "needs-user") needsUser = classified;
    if (classified?.kind === "completed" || classified?.kind === "incomplete") terminal = classified;
  }
  return {
    hasUserTurn: lastUserIndex >= 0,
    lastUserId,
    inFlight: lastUserIndex >= 0 && !terminal,
    terminal,
    needsUser,
  };
}

async function readJsonlState(sessionId, homeDir) {
  const filePath = await findSessionJsonl(sessionId, homeDir);
  if (!filePath) return { filePath: "", raw: "", state: inspectJsonlText("") };
  const raw = await fs.readFile(filePath, "utf8");
  return { filePath, raw, state: inspectJsonlText(raw) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTurn(sessionId, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  const startedAt = Date.now();
  const baselineUserId = String(options.baselineUserId || "");
  let notifiedNeedsUser = false;
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await readJsonlState(sessionId, homeDir);
    const hasTargetTurn = !baselineUserId || (snapshot.state.lastUserId && snapshot.state.lastUserId !== baselineUserId);
    if (hasTargetTurn && snapshot.state.needsUser && !notifiedNeedsUser) {
      notifiedNeedsUser = true;
      options.onNeedsUser?.(snapshot.state.needsUser.text);
    }
    if (hasTargetTurn && snapshot.state.terminal) return { ...snapshot.state.terminal, filePath: snapshot.filePath };
    await sleep(pollMs);
  }
  throw new Error(`等待 WorkBuddy 回复超时（${Math.round(timeoutMs / 1000)} 秒）`);
}

export async function hasInFlightTurn(sessionId, homeDir = os.homedir()) {
  return (await readJsonlState(sessionId, homeDir)).state.inFlight;
}

export class WorkBuddyPtyAdapter {
  constructor(options = {}) {
    this.options = options;
    this.client = options.client || new BridgeClient(options.bridgeUrl || DEFAULT_BRIDGE_URL);
    this.homeDir = options.homeDir || os.homedir();
    this.cwd = options.cwd || process.cwd();
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.sessionId = options.resumeSessionId || "";
    this.queue = Promise.resolve();
  }

  print(text = "") {
    this.stdout.write(`${text}\r\n`);
  }

  printError(text) {
    this.stderr.write(`[WorkBuddy] ${text}\r\n`);
  }

  async initialize() {
    if (this.sessionId) {
      await this.client.getSession(this.sessionId);
      this.print(`[WorkBuddy] 已恢复会话 ${this.sessionId}`);
      await this.client.setModel(this.sessionId, this.options.modelId || DEFAULT_MODEL_ID);
      this.print(`[WorkBuddy] 模型 ${(this.options.modelId || DEFAULT_MODEL_ID)}`);

      if (await hasInFlightTurn(this.sessionId, this.homeDir)) {
        this.print("[WorkBuddy] 检测到未结束回合，正在接回；不会重复发送指令。");
        const terminal = await this.monitorTurn();
        this.printTerminal(terminal);
      }
      this.print("[WorkBuddy] 就绪");
      return this.sessionId;
    }

    this.print("[WorkBuddy] 就绪；收到首条非空指令后才创建会话。");
    return "";
  }

  monitorTurn(baselineUserId = "") {
    return waitForTurn(this.sessionId, {
      homeDir: this.homeDir,
      pollMs: this.options.pollMs,
      timeoutMs: this.options.timeoutMs,
      baselineUserId,
      onNeedsUser: (text) => this.printError(`${text}；请在 WorkBuddy 桌面端处理。`),
    });
  }

  async monitorDispatch(dispatchId, signal) {
    if (!dispatchId || typeof this.client.getMessageDispatch !== "function") return;
    while (!signal?.aborted) {
      const payload = await this.client.getMessageDispatch(dispatchId);
      const dispatch = payload?.dispatch;
      if (dispatch?.status === "error") throw new Error(`WorkBuddy 消息桥接失败：${dispatch.error || "未知错误"}`);
      if (dispatch?.status === "completed") return;
      await sleep(positiveInteger(this.options.pollMs, DEFAULT_POLL_MS));
    }
  }

  printTerminal(terminal) {
    if (terminal.kind === "completed") {
      this.print(terminal.text || "（WorkBuddy 已完成，但未返回文本）");
    } else {
      this.printError(`回合未完成：${terminal.text}`);
    }
  }

  async runPrompt(text) {
    const prompt = String(text || "").trim();
    if (!prompt) return;
    this.print(`> ${prompt}`);

    let initialDispatchId = "";
    if (!this.sessionId) {
      const created = await this.client.createSession(
        this.cwd,
        prompt,
        this.options.modelId || DEFAULT_MODEL_ID
      );
      this.sessionId = String(created.sessionId || created.task?.id || "").trim();
      if (!this.sessionId) throw new Error("桥接未返回 WorkBuddy 会话 ID");
      initialDispatchId = String(created.dispatchId || "").trim();
      this.print(`[WorkBuddy] 已创建会话 ${this.sessionId}`);
      this.print(`[WorkBuddy] 模型 ${(this.options.modelId || DEFAULT_MODEL_ID)}`);
    }

    const before = await readJsonlState(this.sessionId, this.homeDir);
    const baselineUserId = initialDispatchId ? "" : before.state.lastUserId;
    const turnPromise = this.monitorTurn(baselineUserId);
    const sendOutcome = initialDispatchId
      ? Promise.resolve({ kind: "accepted", payload: { dispatchId: initialDispatchId } })
      : this.client.sendMessage(this.sessionId, prompt).then(
          (payload) => ({ kind: "accepted", payload }),
          (error) => ({ kind: "send-error", error })
        );
    const first = await Promise.race([
      turnPromise.then((terminal) => ({ kind: "terminal", terminal })),
      sendOutcome,
    ]);

    if (first.kind === "terminal") {
      this.printTerminal(first.terminal);
      return;
    }
    if (first.kind === "send-error") {
      const after = await readJsonlState(this.sessionId, this.homeDir);
      const acceptedByDesktop = Boolean(
        after.state.lastUserId && after.state.lastUserId !== before.state.lastUserId
      );
      if (!acceptedByDesktop) throw first.error;
      const terminal = await turnPromise;
      this.printTerminal(terminal);
      return;
    }

    const dispatchMonitor = new AbortController();
    const dispatchPromise = this.monitorDispatch(first.payload.dispatchId, dispatchMonitor.signal);
    try {
      const terminal = await Promise.race([
        turnPromise,
        dispatchPromise.then(() => turnPromise),
      ]);
      this.printTerminal(terminal);
    } finally {
      dispatchMonitor.abort();
    }
  }

  enqueue(text) {
    const task = this.queue.then(() => this.runPrompt(text));
    this.queue = task.catch((error) => {
      this.printError(error instanceof Error ? error.message : String(error));
    });
    return task;
  }
}

export function attachRawInput(adapter, input = process.stdin) {
  let buffer = "";
  if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  const onData = (chunk) => {
    for (const char of chunk) {
      if (char === "\u0003" || char === "\u0004") {
        adapter.printError("本地适配器已退出；WorkBuddy 远端回合不会被删除，恢复时会自动接回。");
        process.kill(process.pid, "SIGTERM");
        return;
      }
      if (char === "\r") {
        const prompt = buffer;
        buffer = "";
        void adapter.enqueue(prompt);
      } else if (char === "\u007f") {
        buffer = buffer.slice(0, -1);
      } else {
        buffer += char;
      }
    }
  };
  input.on("data", onData);
  return () => {
    input.off("data", onData);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(false);
    input.pause();
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const adapter = new WorkBuddyPtyAdapter(options);
  await adapter.initialize();
  if (options.initialPrompt) void adapter.enqueue(options.initialPrompt);
  const detach = attachRawInput(adapter);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    detach();
    if (adapter.sessionId) {
      adapter.printError(`收到 ${signal}，仅退出本地适配器；已有内容的 WorkBuddy 会话 ${adapter.sessionId} 保留。`);
    } else {
      adapter.printError(`收到 ${signal}；尚未创建 WorkBuddy 会话，不会留下空任务。`);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
