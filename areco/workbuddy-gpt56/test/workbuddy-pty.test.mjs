import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";

import {
  WorkBuddyPtyAdapter,
  attachRawInput,
  classifyJsonlEvent,
  findSessionJsonl,
  hasInFlightTurn,
  inspectJsonlText,
  inspectJsonlTurns,
  parseArgs,
  waitForTurn,
} from "../src/cli/workbuddy-pty.mjs";

test("parseArgs supports bridge, model, resume and initial prompt", () => {
  assert.deepEqual(
    parseArgs(["--bridge", "http://localhost:8780/", "--model", "m1", "--resume", "s1", "hello", "world"]),
    {
      bridgeUrl: "http://localhost:8780",
      modelId: "m1",
      modelExplicitlySet: true,
      resumeSessionId: "s1",
      pollMs: 500,
      timeoutMs: 1_800_000,
      initialPrompt: "hello world",
    }
  );
  assert.throws(() => parseArgs(["--unknown"]), /未知参数/u);
});

test("classifyJsonlEvent recognizes completed, incomplete and user input tools", () => {
  assert.deepEqual(
    classifyJsonlEvent({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] }),
    { kind: "completed", text: "OK" }
  );
  assert.deepEqual(
    classifyJsonlEvent({ type: "message", role: "assistant", status: "incomplete", providerData: { error: { message: "Interrupted" } } }),
    { kind: "incomplete", text: "Interrupted" }
  );
  assert.equal(classifyJsonlEvent({ type: "function_call", name: "AskUserQuestion" }).kind, "needs-user");
});

test("inspectJsonlText only treats a terminal assistant message after the latest user as done", () => {
  const row = (value) => JSON.stringify(value);
  const raw = [
    row({ type: "message", role: "user", content: [] }),
    row({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "old" }] }),
    row({ type: "message", role: "user", content: [] }),
    row({ type: "reasoning", content: [] }),
  ].join("\n");
  assert.equal(inspectJsonlText(raw).inFlight, true);
  assert.equal(inspectJsonlText(raw).lastUserId, "2");
  const done = inspectJsonlText(`${raw}\n${row({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "new" }] })}\n`);
  assert.equal(done.inFlight, false);
  assert.deepEqual(done.terminal, { kind: "completed", text: "new" });
});

test("inspectJsonlTurns keeps user text and terminal identities per turn", () => {
  const raw = [
    JSON.stringify({ type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "GUI prompt" }] }),
    JSON.stringify({ type: "message", role: "assistant", id: "a1", status: "completed", content: [{ type: "output_text", text: "GUI answer" }] }),
  ].join("\n");
  assert.deepEqual(inspectJsonlTurns(raw), [{
    userId: "u1",
    userText: "GUI prompt",
    userIndex: 0,
    terminal: { kind: "completed", text: "GUI answer" },
    terminalId: "a1",
    needsUser: null,
  }]);
});

test("findSessionJsonl and waitForTurn follow the target session file", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const projectDir = path.join(home, ".workbuddy", "projects", "tmp-project");
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ type: "message", role: "user", content: [] })}\n`, "utf8");
    assert.equal(await findSessionJsonl(sessionId, home), file);
    assert.equal(await hasInFlightTurn(sessionId, home), true);
    const pending = waitForTurn(sessionId, { homeDir: home, pollMs: 10, timeoutMs: 1000 });
    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ready" }] })}\n`);
    assert.deepEqual(await pending, { kind: "completed", text: "ready", filePath: file });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("adapter defers session creation until first prompt and serializes later prompts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const calls = [];
  const output = [];
  let turn = 0;
  const client = {
    async createSession(cwd, text, modelId) {
      calls.push(["create-and-prompt", cwd, text, modelId]);
      turn += 1;
      await fs.writeFile(file, `${JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text }] })}\n`, "utf8");
      setTimeout(() => {
        void fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `answer-${turn}` }] })}\n`);
      }, 10);
      return { sessionId, dispatchId: `dispatch-${turn}` };
    },
    async setModel(id, model) { calls.push(["model", id, model]); return { ok: true }; },
    async sendMessage(id, text) {
      calls.push(["send", id, text]);
      turn += 1;
      await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text }] })}\n`);
      setTimeout(() => {
        void fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `answer-${turn}` }] })}\n`);
      }, 10);
      return { ok: true, dispatchId: `dispatch-${turn}` };
    },
    async getMessageDispatch() { return { dispatch: { status: "pending" } }; },
  };
  try {
    await fs.mkdir(projectDir, { recursive: true });
    const adapter = new WorkBuddyPtyAdapter({
      bridgeUrl: "http://bridge",
      modelId: "m1",
      cwd: "/workspace",
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client,
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    });
    assert.equal(await adapter.initialize(), "");
    assert.deepEqual(calls, []);
    await Promise.all([adapter.enqueue("first"), adapter.enqueue("second")]);
    assert.deepEqual(calls[0], ["create-and-prompt", "/workspace", "first", "m1"]);
    assert.deepEqual(calls.filter((call) => call[0] === "send").map((call) => call[2]), ["second"]);
    assert.match(output.join(""), /answer-1/u);
    assert.match(output.join(""), /answer-2/u);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("adapter keeps monitoring JSONL when legacy send HTTP fails after desktop acceptance", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const output = [];
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, "", "utf8");
    const adapter = new WorkBuddyPtyAdapter({
      resumeSessionId: sessionId,
      modelId: "m1",
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client: {
        async getSession() { return { ok: true }; },
        async setModel() { return { ok: true }; },
        async sendMessage() {
          await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "user", id: "accepted-user", content: [] })}\n`);
          setTimeout(() => void fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "recovered" }] })}\n`), 10);
          throw new Error("HTTP 500 legacy timeout");
        },
      },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    });
    await adapter.initialize();
    await adapter.runPrompt("hello");
    assert.match(output.join(""), /recovered/u);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("adapter reports asynchronous message bridge failures", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, "", "utf8");
    const adapter = new WorkBuddyPtyAdapter({
      resumeSessionId: sessionId,
      modelId: "m1",
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client: {
        async getSession() { return { ok: true }; },
        async setModel() { return { ok: true }; },
        async sendMessage() { return { ok: true, dispatchId: "dispatch-failed" }; },
        async getMessageDispatch() { return { dispatch: { status: "error", error: "daemon exploded" } }; },
      },
      stdout: { write() {} },
      stderr: { write() {} },
    });
    await adapter.initialize();
    await assert.rejects(adapter.runPrompt("hello"), /daemon exploded/u);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("adapter resume keeps the existing model unless --model was explicit", async () => {
  const calls = [];
  const adapter = new WorkBuddyPtyAdapter({
    resumeSessionId: "existing-session",
    modelId: "m1",
    modelExplicitlySet: false,
    homeDir: await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-")),
    client: {
      async getSession(id) { calls.push(["get", id]); return { ok: true }; },
      async setModel(id, model) { calls.push(["model", id, model]); return { ok: true }; },
    },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  await adapter.initialize();
  assert.deepEqual(calls, [["get", "existing-session"]]);
  await adapter.stopSessionWatcher();
});

test("adapter resume validates the session and reconnects an in-flight turn without resending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const calls = [];
  const output = [];
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ type: "message", role: "user", content: [] })}\n`);
    const adapter = new WorkBuddyPtyAdapter({
      resumeSessionId: sessionId,
      modelId: "m1",
      modelExplicitlySet: true,
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client: {
        async getSession(id) { calls.push(["get", id]); return { ok: true }; },
        async setModel(id, model) { calls.push(["model", id, model]); return { ok: true }; },
        async sendMessage() { calls.push(["send"]); },
      },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    });
    await adapter.initialize();
    assert.deepEqual(calls, [["get", sessionId], ["model", sessionId, "m1"]]);
    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", id: "resumed-a", status: "completed", content: [{ type: "output_text", text: "resumed" }] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(output.join(""), /resumed/u);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("resume returns ready immediately, mirrors GUI turns, and does not replay history", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const output = [];
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, [
      JSON.stringify({ type: "message", role: "user", id: "old-u", content: [{ type: "input_text", text: "old prompt" }] }),
      JSON.stringify({ type: "message", role: "assistant", id: "old-a", status: "completed", content: [{ type: "output_text", text: "old answer" }] }),
      JSON.stringify({ type: "message", role: "user", id: "busy-u", content: [{ type: "input_text", text: "busy prompt" }] }),
    ].join("\n") + "\n");
    const adapter = new WorkBuddyPtyAdapter({
      resumeSessionId: sessionId,
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client: { async getSession() { return { ok: true }; } },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    });
    await adapter.initialize();
    assert.match(output.join(""), /已在后台接回/u);
    assert.doesNotMatch(output.join(""), /old answer/u);

    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", id: "busy-a", status: "completed", content: [{ type: "output_text", text: "busy answer" }] })}\n`);
    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "user", id: "gui-u", content: [{ type: "input_text", text: "GUI asks" }] })}\n`);
    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", id: "gui-a", status: "completed", content: [{ type: "output_text", text: "GUI replies" }] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(output.join(""), /\[WorkBuddy GUI\] busy answer/u);
    assert.match(output.join(""), /\[WorkBuddy GUI\] > GUI asks/u);
    assert.match(output.join(""), /\[WorkBuddy GUI\] GUI replies/u);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("local prompt waits for an active GUI turn and is not mirrored twice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-pty-test-"));
  const projectDir = path.join(home, ".workbuddy", "projects", "proj");
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const output = [];
  const calls = [];
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ type: "message", role: "user", id: "gui-busy-u", content: [{ type: "input_text", text: "GUI busy" }] })}\n`);
    const adapter = new WorkBuddyPtyAdapter({
      resumeSessionId: sessionId,
      homeDir: home,
      pollMs: 5,
      timeoutMs: 1000,
      client: {
        async getSession() { return { ok: true }; },
        async sendMessage(id, text) {
          calls.push([id, text]);
          await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "user", id: "local-u", content: [{ type: "input_text", text }] })}\n`);
          setTimeout(() => void fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", id: "local-a", status: "completed", content: [{ type: "output_text", text: "local answer" }] })}\n`), 10);
          return { dispatchId: "local-dispatch" };
        },
        async getMessageDispatch() { return { dispatch: { status: "pending" } }; },
      },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    });
    await adapter.initialize();
    const pending = adapter.runPrompt("local prompt");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(calls, []);
    await fs.appendFile(file, `${JSON.stringify({ type: "message", role: "assistant", id: "gui-busy-a", status: "completed", content: [{ type: "output_text", text: "GUI finished" }] })}\n`);
    await pending;
    assert.deepEqual(calls, [[sessionId, "local prompt"]]);
    const rendered = output.join("");
    assert.match(rendered, /GUI finished/u);
    assert.match(rendered, /local answer/u);
    assert.doesNotMatch(rendered, /\[WorkBuddy GUI\] > local prompt/u);
    assert.equal((rendered.match(/local answer/gu) || []).length, 1);
    await adapter.stopSessionWatcher();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("raw input uses carriage return as submit boundary and preserves embedded newlines", async () => {
  const input = new PassThrough();
  input.isTTY = false;
  const prompts = [];
  const adapter = {
    enqueue(text) { prompts.push(text); return Promise.resolve(); },
    printError() {},
  };
  const detach = attachRawInput(adapter, input);
  input.write("line1\nline2\rnext\r");
  await new Promise((resolve) => setImmediate(resolve));
  detach();
  assert.deepEqual(prompts, ["line1\nline2", "next"]);
});
