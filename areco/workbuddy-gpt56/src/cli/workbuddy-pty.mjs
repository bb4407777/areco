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
    modelExplicitlySet: false,
    resumeSessionId: "",
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    initialPrompt: "",
  };
  const promptParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bridge") options.bridgeUrl = String(argv[++index] || "").trim();
    else if (arg === "--model") {
      options.modelId = String(argv[++index] || "").trim();
      options.modelExplicitlySet = true;
    }
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
    .filter((block) => block && typeof block === "object" && ["input_text", "output_text", "text"].includes(block.type))
    .map((block) => String(block.text || ""))
    .join("");
}

// WorkBuddy GUI 落盘的 user 消息不是裸文本：真实指令包在信封里——
//   <system-reminder data-role="user-context">…几 KB 系统注入…</system-reminder>
//   <user_query>真实指令</user_query>
// （chatlog 提取器 2026-07-13 起同款剥离逻辑。）此前 inspectJsonlTurns 直接拿全文当
// userText，与 runPrompt 发送的裸 prompt 全文精确比对永不相等 → turnAfterBaseline/
// claimLocalTurn 全部落空，新会话回合永远匹配不上、等到超时（2026-08-02 真机实锤：
// GUI 26 秒完成「链路正常」，PTY 侧 150 秒超时）。单测此前全用裸文本造假 JSONL，
// 信封格式从没进过用例——单测全绿、真机必死。
export function userPromptText(raw) {
  const text = String(raw || "");
  // 真实 user_query 在信封末尾；取最后一个匹配，防 system-reminder 正文里出现示例标签
  const openTag = "<user_query>";
  const start = text.lastIndexOf(openTag);
  if (start !== -1) {
    const rest = text.slice(start + openTag.length);
    const end = rest.indexOf("</user_query>");
    return (end === -1 ? rest : rest.slice(0, end)).trim();
  }
  // 兜底：没有 user_query 标签（旧版 GUI/其它来源）就剥掉 system-reminder 块
  return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gu, "").trim();
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

function jsonlEventId(event, index) {
  return String(event?.id || event?.messageId || event?.timestamp || index);
}

export function inspectJsonlTurns(raw) {
  const turns = [];
  let currentTurn = null;
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
      currentTurn = {
        userId: jsonlEventId(event, index),
        userText: userPromptText(contentText(event.content)),
        userIndex: index,
        terminal: null,
        terminalId: "",
        needsUser: null,
      };
      turns.push(currentTurn);
      continue;
    }
    if (!currentTurn) continue;
    const classified = classifyJsonlEvent(event);
    if (classified?.kind === "needs-user") currentTurn.needsUser = classified;
    if (classified?.kind === "completed" || classified?.kind === "incomplete") {
      currentTurn.terminal = classified;
      currentTurn.terminalId = jsonlEventId(event, index);
    }
  }
  return turns;
}

function jsonlStateFromTurns(turns) {
  const lastTurn = turns.at(-1) || null;
  return {
    hasUserTurn: Boolean(lastTurn),
    lastUserId: lastTurn?.userId || "",
    inFlight: Boolean(lastTurn && !lastTurn.terminal),
    terminal: lastTurn?.terminal || null,
    needsUser: lastTurn?.needsUser || null,
  };
}

export function inspectJsonlText(raw) {
  return jsonlStateFromTurns(inspectJsonlTurns(raw));
}

async function readJsonlState(sessionId, homeDir) {
  const filePath = await findSessionJsonl(sessionId, homeDir);
  if (!filePath) return { filePath: "", raw: "", state: jsonlStateFromTurns([]), turns: [] };
  const raw = await fs.readFile(filePath, "utf8");
  const turns = inspectJsonlTurns(raw);
  return { filePath, raw, state: jsonlStateFromTurns(turns), turns };
}

function turnAfterBaseline(turns, baselineUserIds, prompt = "") {
  const expectedText = String(prompt || "").trim();
  const freshTurns = turns.filter((turn) => !baselineUserIds.has(turn.userId));
  if (!expectedText) return freshTurns[0] || null;
  return freshTurns.find((turn) => turn.userText === expectedText) || null;
}

async function waitForPromptTurn(sessionId, prompt, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  const baselineUserIds = new Set(options.baselineUserIds || []);
  const startedAt = Date.now();
  let notifiedNeedsUser = false;
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await readJsonlState(sessionId, homeDir);
    const turn = options.targetUserId
      ? snapshot.turns.find((candidate) => candidate.userId === options.targetUserId) || null
      : turnAfterBaseline(snapshot.turns, baselineUserIds, prompt);
    if (turn?.needsUser && !notifiedNeedsUser) {
      notifiedNeedsUser = true;
      options.onNeedsUser?.(turn.needsUser.text);
    }
    if (turn?.terminal) {
      return {
        ...turn.terminal,
        filePath: snapshot.filePath,
        userId: turn.userId,
        terminalId: turn.terminalId,
      };
    }
    await sleep(pollMs);
  }
  throw new Error(`等待 WorkBuddy 回复超时（${Math.round(timeoutMs / 1000)} 秒）`);
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
    this.watcherRunning = false;
    this.watcherPromise = null;
    this.watcherWake = null;
    this.watcherKnownUserIds = new Set();
    this.watcherKnownTerminalIds = new Set();
    this.watcherKnownNeedsUserIds = new Set();
    this.localTurnIds = new Set();
    this.activePrompt = null;
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
      if (this.options.modelExplicitlySet) {
        await this.client.setModel(this.sessionId, this.options.modelId || DEFAULT_MODEL_ID);
        this.print(`[WorkBuddy] 模型 ${(this.options.modelId || DEFAULT_MODEL_ID)}`);
      }

      const snapshot = await readJsonlState(this.sessionId, this.homeDir);
      await this.startSessionWatcher(snapshot);
      if (snapshot.state.inFlight) {
        this.print("[WorkBuddy] 检测到未结束回合，已在后台接回；仍可继续输入，指令会按顺序发送。");
      }
      this.print("[WorkBuddy] 就绪");
      return this.sessionId;
    }

    this.print("[WorkBuddy] 就绪；收到首条非空指令后才创建会话。");
    return "";
  }

  async waitUntilSessionIdle() {
    const startedAt = Date.now();
    const timeoutMs = positiveInteger(this.options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    while (Date.now() - startedAt <= timeoutMs) {
      const snapshot = await readJsonlState(this.sessionId, this.homeDir);
      if (!snapshot.state.inFlight) return snapshot;
      await sleep(positiveInteger(this.options.pollMs, DEFAULT_POLL_MS));
    }
    throw new Error(`等待 WorkBuddy 当前回合结束超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  async startSessionWatcher(initialSnapshot = null) {
    if (!this.sessionId || this.watcherRunning) return;
    const snapshot = initialSnapshot || await readJsonlState(this.sessionId, this.homeDir);
    for (const turn of snapshot.turns) {
      this.watcherKnownUserIds.add(turn.userId);
      if (turn.terminalId) this.watcherKnownTerminalIds.add(turn.terminalId);
      if (turn.needsUser) this.watcherKnownNeedsUserIds.add(turn.userId);
    }
    if (snapshot.state.inFlight) {
      const current = snapshot.turns.at(-1);
      if (current?.terminalId) this.watcherKnownTerminalIds.delete(current.terminalId);
    }
    this.watcherRunning = true;
    this.watcherPromise = this.watchSessionLoop();
  }

  async stopSessionWatcher() {
    this.watcherRunning = false;
    this.watcherWake?.();
    await this.watcherPromise;
    this.watcherPromise = null;
  }

  claimLocalTurn(turn) {
    const active = this.activePrompt;
    if (!active || active.userId || active.baselineUserIds.has(turn.userId)) return false;
    if (turn.userText !== active.text) return false;
    active.userId = turn.userId;
    this.localTurnIds.add(turn.userId);
    return true;
  }

  async syncSessionEvents() {
    if (!this.sessionId) return;
    const snapshot = await readJsonlState(this.sessionId, this.homeDir);
    for (const turn of snapshot.turns) {
      const isNewUser = !this.watcherKnownUserIds.has(turn.userId);
      const isLocal = this.localTurnIds.has(turn.userId) || this.claimLocalTurn(turn);
      if (isNewUser) {
        this.watcherKnownUserIds.add(turn.userId);
        if (!isLocal) this.print(`[WorkBuddy GUI] > ${turn.userText || "（非文本指令）"}`);
      }
      if (turn.needsUser && !this.watcherKnownNeedsUserIds.has(turn.userId)) {
        this.watcherKnownNeedsUserIds.add(turn.userId);
        this.printError(`${turn.needsUser.text}；请在 WorkBuddy 桌面端处理。`);
      }
      if (turn.terminalId && !this.watcherKnownTerminalIds.has(turn.terminalId)) {
        this.watcherKnownTerminalIds.add(turn.terminalId);
        if (!isLocal) this.printTerminal({ ...turn.terminal, terminalId: turn.terminalId }, "[WorkBuddy GUI] ");
      }
    }
  }

  async watchSessionLoop() {
    while (this.watcherRunning) {
      try {
        await this.syncSessionEvents();
      } catch (error) {
        this.printError(`会话同步暂时失败，将自动重试：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!this.watcherRunning) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, positiveInteger(this.options.pollMs, DEFAULT_POLL_MS));
        timer.unref?.();
        this.watcherWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.watcherWake = null;
    }
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

  printTerminal(terminal, prefix = "") {
    if (terminal.kind === "completed") {
      this.print(`${prefix}${terminal.text || "（WorkBuddy 已完成，但未返回文本）"}`);
    } else {
      this.printError(`${prefix}回合未完成：${terminal.text}`);
    }
  }

  async runPrompt(text) {
    const prompt = String(text || "").trim();
    if (!prompt) return;
    this.print(`> ${prompt}`);

    let dispatchId = "";
    let before;
    if (!this.sessionId) {
      const created = await this.client.createSession(
        this.cwd,
        prompt,
        this.options.modelId || DEFAULT_MODEL_ID
      );
      this.sessionId = String(created.sessionId || created.task?.id || "").trim();
      if (!this.sessionId) throw new Error("桥接未返回 WorkBuddy 会话 ID");
      dispatchId = String(created.dispatchId || "").trim();
      before = { turns: [], state: inspectJsonlText("") };
      this.activePrompt = { text: prompt, baselineUserIds: new Set(), userId: "" };
      this.print(`[WorkBuddy] 已创建会话 ${this.sessionId}`);
      this.print(`[WorkBuddy] 模型 ${(this.options.modelId || DEFAULT_MODEL_ID)}`);
      await this.startSessionWatcher(await readJsonlState(this.sessionId, this.homeDir));
    } else {
      before = await this.waitUntilSessionIdle();
      const baselineUserIds = new Set(before.turns.map((turn) => turn.userId));
      this.activePrompt = { text: prompt, baselineUserIds, userId: "" };
      try {
        const payload = await this.client.sendMessage(this.sessionId, prompt);
        dispatchId = String(payload?.dispatchId || "").trim();
      } catch (error) {
        const after = await readJsonlState(this.sessionId, this.homeDir);
        const freshTurns = after.turns.filter((turn) => !baselineUserIds.has(turn.userId));
        const acceptedTurn = turnAfterBaseline(after.turns, baselineUserIds, prompt)
          || (freshTurns.length === 1 && !freshTurns[0].userText ? freshTurns[0] : null);
        if (!acceptedTurn) {
          this.activePrompt = null;
          throw error;
        }
        this.activePrompt.userId = acceptedTurn.userId;
        this.localTurnIds.add(acceptedTurn.userId);
      }
    }

    const baselineUserIds = this.activePrompt?.baselineUserIds || new Set(before.turns.map((turn) => turn.userId));
    const turnPromise = waitForPromptTurn(this.sessionId, prompt, {
      homeDir: this.homeDir,
      pollMs: this.options.pollMs,
      timeoutMs: this.options.timeoutMs,
      baselineUserIds,
      targetUserId: this.activePrompt?.userId || "",
      onNeedsUser: (message) => this.printError(`${message}；请在 WorkBuddy 桌面端处理。`),
    });
    const dispatchMonitor = new AbortController();
    const dispatchPromise = this.monitorDispatch(dispatchId, dispatchMonitor.signal);
    try {
      const terminal = await Promise.race([
        turnPromise,
        dispatchPromise.then(() => turnPromise),
      ]);
      if (terminal.userId) this.localTurnIds.add(terminal.userId);
      if (terminal.terminalId) this.watcherKnownTerminalIds.add(terminal.terminalId);
      this.printTerminal(terminal);
    } finally {
      this.activePrompt = null;
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
    adapter.stopSessionWatcher();
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
