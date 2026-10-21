import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import asyncSubagents, {
	buildPiArgs, consumeAgentEvent, createAgentOutputState, formatCompletionMessage,
} from "../extensions/async-subagents/index.ts";
import { JobStore } from "../extensions/async-subagents/jobs.ts";
import { terminateProcessTree } from "../extensions/async-subagents/process.ts";

async function eventually(predicate: () => boolean, timeout = 6000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

const answer = (text: string) => JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
		usage: { input: 2, output: 3, cost: { total: 0.01 } } },
});

async function harness(source: string, options: { ack?: boolean; max?: string; timeout?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "async-subagents-runtime-"));
	const fakePi = join(dir, "fake-pi.js");
	writeFileSync(fakePi, source);
	const env = {
		PI_ASYNC_SUBAGENT_PI: fakePi,
		PI_ASYNC_SUBAGENT_STATE_DIR: join(dir, "state"),
		PI_ASYNC_SUBAGENT_MAX: options.max || "4",
		PI_ASYNC_SUBAGENT_TIMEOUT_SECONDS: options.timeout || "600",
	};
	const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const messages: any[] = [];
	const notifications: string[] = [];
	const branch: any[] = [{ id: "origin", type: "message", message: { role: "assistant" } }];
	let failDelivery = false;
	let acknowledge = options.ack !== false;
	let sessionId = "session-one";
	let idle = false;
	let pending = true;
	const ctx = {
		isIdle: () => idle, hasPendingMessages: () => pending,
		cwd: dir, hasUI: true, mode: "tui", model: { provider: "mock", id: "parent" },
		sessionManager: {
			getSessionId: () => sessionId, getLeafId: () => "origin", getBranch: () => branch,
		},
		ui: { setStatus() {}, notify(text: string) { notifications.push(text); } },
	};
	const api: any = {
		on(event: string, handler: Function) { handlers.set(event, handler); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage(message: any, deliveryOptions: any) {
			if (failDelivery) throw new Error("simulated delivery failure");
			messages.push({ ...message, options: deliveryOptions });
			if (acknowledge) {
				branch.push({ id: randomUUID(), type: "custom_message", ...message });
				handlers.get("message_end")!({ message: { role: "custom", ...message } }, ctx);
			}
		},
	};
	asyncSubagents(api);
	await handlers.get("session_start")!({}, ctx);
	const call = (name: string, params: any, signal?: AbortSignal) => tools.get(name).execute("call-id", params, signal, undefined, ctx);
	return {
		dir, fakePi, tools, messages, notifications, branch, handlers, ctx,
		call,
		start: (params: any = {}) => call("subagent", { agent: "scout", task: "test task", ...params }),
		status: async (id: string) => (await call("subagents_status", { id })).details.jobs[0],
		command: (args: string) => commands.get("subagents").handler(args, ctx),
		setFailDelivery: (value: boolean) => { failDelivery = value; },
		setAck: (value: boolean) => { acknowledge = value; },
		setQueue: (isIdle: boolean, hasPending: boolean) => { idle = isIdle; pending = hasPending; },
		async reload(nextSession = sessionId) {
			await handlers.get("session_shutdown")!({}, ctx);
			sessionId = nextSession;
			asyncSubagents(api);
			await handlers.get("session_start")!({}, ctx);
		},
		async close() {
			await handlers.get("session_shutdown")!({}, ctx);
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("recovered assistant errors do not poison final completion", () => {
	const state = createAgentOutputState();
	consumeAgentEvent(state, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429" } });
	assert.equal(state.error, "429");
	consumeAgentEvent(state, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "Recovered" } });
	assert.equal(state.error, undefined);
	assert.equal(state.text, "Recovered");
	consumeAgentEvent(state, { type: "auto_retry_end", success: false, finalError: "exhausted" });
	assert.equal(state.error, "exhausted");
	consumeAgentEvent(state, { type: "auto_retry_end", success: true });
	assert.equal(state.error, undefined);
});

test("an empty successful final message does not reuse earlier commentary", () => {
	const state = createAgentOutputState();
	consumeAgentEvent(state, JSON.parse(answer("Working...")));
	consumeAgentEvent(state, JSON.parse(answer("")));
	assert.equal(state.text, "");
});

test("success and failure output are bounded and point to full artifacts", () => {
	const state = createAgentOutputState();
	state.text = "x".repeat(200_000);
	const job = { name: "test", agent: "scout", task: "test", startedAt: 0 };
	for (const exitCode of [0, 1]) {
		const content = formatCompletionMessage(job, state, exitCode, undefined, 100, "/tmp/output.md");
		assert.match(content, /output truncated/);
		assert.match(content, /Full output: \/tmp\/output.md/);
		assert.ok(content.length < 121_000);
	}
});

test("model precedence is explicit > profile > inherited and prompt filename is safe", () => {
	const agent = { name: "../../escape", description: "", tools: ["read"], systemPrompt: "safe", filePath: "/tmp/agent.md", model: "profile/model" };
	for (const [profile, override, expected] of [
		["profile/model", "explicit/model", "explicit/model"],
		["profile/model", undefined, "profile/model"],
		[undefined, undefined, "parent/model"],
	]) {
		const built = buildPiArgs({ ...agent, model: profile }, "task", "/tmp", override, "parent/model");
		try {
			assert.equal(built.args[built.args.indexOf("--model") + 1], expected);
			assert.equal(built.args[built.args.indexOf("--append-system-prompt") + 1], join(built.tempDir, "system.md"));
			assert.equal(readFileSync(join(built.tempDir, "system.md"), "utf8"), "safe");
		} finally { rmSync(built.tempDir, { recursive: true, force: true }); }
	}
});

test("completion persists private full output and waits for delivery acknowledgement", async () => {
	const text = "界".repeat(125_000);
	const h = await harness(`console.log(${JSON.stringify(answer(text))});`, { ack: false });
	try {
		const launched = await h.start();
		const id = launched.details.id;
		assert.equal(launched.details.status, "running");
		await eventually(() => h.messages.length === 1);
		const message = h.messages[0];
		assert.match(message.content, /output truncated/);
		assert.equal(readFileSync(message.details.outputPath, "utf8"), text);
		assert.equal((await h.status(id)).delivery, "queued");
		assert.ok(readFileSync(join(message.details.artifactDir, "job.json"), "utf8").length < 122_000);
		if (process.platform !== "win32") assert.equal(statSync(message.details.outputPath).mode & 0o777, 0o600);
		await h.handlers.get("message_end")!({ message: { role: "custom", ...message } }, h.ctx);
		assert.equal((await h.status(id)).delivery, "delivered");
		assert.equal(JSON.parse(readFileSync(join(message.details.artifactDir, "job.json"), "utf8")).delivery, "delivered");
		await h.command(`retry ${id}`);
		assert.equal(h.messages.length, 1, "acknowledged output must not be resent");
	} finally { await h.close(); }
});

test("failed delivery is recoverable after reload, without duplicating successful delivery", async () => {
	const h = await harness(`console.log(${JSON.stringify(answer("recover me"))});`);
	try {
		h.setFailDelivery(true);
		const { details } = await h.start();
		const metadata = join(details.artifactDir, "job.json");
		await eventually(() => JSON.parse(readFileSync(metadata, "utf8")).status === "completed");
		assert.equal((await h.status(details.id)).delivery, "pending");
		assert.match((await h.status(details.id)).deliveryError, /simulated/);
		await h.reload();
		h.setFailDelivery(false);
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 1);
		assert.match(h.messages[0].content, /recover me/);
		assert.equal((await h.status(details.id)).delivery, "delivered");
		await h.reload();
		assert.equal((await h.status(details.id)).delivery, "delivered");
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 1);
	} finally { await h.close(); }
});

test("unacknowledged queued results become pending after reload", async () => {
	const h = await harness(`console.log(${JSON.stringify(answer("queued result"))});`, { ack: false });
	try {
		const { details } = await h.start();
		await eventually(() => h.messages.length === 1);
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 1);
		await h.reload();
		assert.equal((await h.status(details.id)).delivery, "pending");
		h.setAck(true);
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 2);
		assert.equal((await h.status(details.id)).delivery, "delivered");
	} finally { await h.close(); }
});

test("branch changes withhold automatic delivery; explicit retry opts into the current branch", async () => {
	const h = await harness(`setTimeout(() => console.log(${JSON.stringify(answer("other branch"))}), 100);`);
	try {
		const { details } = await h.start();
		h.branch.splice(0, h.branch.length, { id: "different", type: "message" });
		await h.handlers.get("session_tree")!({}, h.ctx);
		await eventually(() => JSON.parse(readFileSync(join(details.artifactDir, "job.json"), "utf8")).status === "completed");
		assert.equal(h.messages.length, 0);
		assert.equal((await h.status(details.id)).delivery, "pending");
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 1);
	} finally { await h.close(); }
});

test("session replacement does not expose or deliver previous-session jobs", async () => {
	const h = await harness("setInterval(() => {}, 1000);");
	try {
		const { details } = await h.start();
		await h.reload("session-two");
		assert.equal(h.messages.length, 0);
		await assert.rejects(h.status(details.id), /Unknown subagent job/);
		const stored = JSON.parse(readFileSync(join(details.artifactDir, "job.json"), "utf8"));
		assert.equal(stored.status, "cancelled");
		assert.equal(stored.suppressDelivery, true);
	} finally { await h.close(); }
});

test("cancellation is idempotent, preserves output and frees the concurrency slot", async () => {
	const h = await harness(`console.log(${JSON.stringify(answer("partial answer"))}); setInterval(() => {}, 1000);`, { max: "1" });
	try {
		const { details } = await h.start();
		await eventually(() => existsSync(join(details.artifactDir, "events.jsonl")));
		await assert.rejects(h.start(), /Too many running subagents/);
		const result = await h.call("subagent_cancel", { id: details.id });
		assert.equal(result.details.status, "cancelled");
		assert.equal(h.messages.length, 1);
		assert.match(h.messages[0].content, /was cancelled/);
		assert.equal(readFileSync(h.messages[0].details.outputPath, "utf8"), "partial answer");
		await h.call("subagent_cancel", { id: details.id });
		assert.equal(h.messages.length, 1);
		const next = await h.start();
		assert.equal(next.details.status, "running");
		await h.command(`cancel ${next.details.id}`);
		assert.equal((await h.status(next.details.id)).status, "cancelled");
	} finally { await h.close(); }
});

test("wall-clock timeout produces a distinct timed_out result", async () => {
	const h = await harness("setInterval(() => {}, 1000);", { timeout: "1" });
	try {
		const { details } = await h.start();
		assert.equal(details.timeoutSeconds, 1);
		await eventually(() => h.messages.length === 1);
		assert.equal((await h.status(details.id)).status, "timed_out");
		assert.match(h.messages[0].content, /timed out/);
		assert.match(h.messages[0].content, /1s wall-clock/);
	} finally { await h.close(); }
});

test("timeout override and validation; pre-aborted launches do not spawn", async () => {
	const h = await harness("setInterval(() => {}, 1000);", { timeout: "1" });
	try {
		await assert.rejects(h.start({ timeoutSeconds: 0 }), /timeoutSeconds/);
		await assert.rejects(h.start({ timeoutSeconds: Infinity }), /timeoutSeconds/);
		const controller = new AbortController(); controller.abort();
		await assert.rejects(h.call("subagent", { agent: "scout", task: "test" }, controller.signal), /aborted/);
		const { details } = await h.start({ timeoutSeconds: 20 });
		assert.equal(details.timeoutSeconds, 20);
		assert.equal((await h.status(details.id)).timeoutSeconds, 20);
	} finally { await h.close(); }
});

test("missing executable is recorded as failed exactly once", async () => {
	const h = await harness("");
	try {
		process.env.PI_ASYNC_SUBAGENT_PI = join(h.dir, "not-an-executable");
		const { details } = await h.start();
		await eventually(() => h.messages.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(h.messages.length, 1);
		assert.equal((await h.status(details.id)).status, "failed");
		assert.match(h.messages[0].content, /ENOENT/);
	} finally { await h.close(); }
});

test("split UTF-8 and a final JSON line without a newline are decoded correctly", async () => {
	const h = await harness(`const data = Buffer.from(${JSON.stringify(answer("hello 界 🌍"))});
		let i = 0; const timer = setInterval(() => { if (i < data.length) process.stdout.write(data.subarray(i, ++i)); else clearInterval(timer); }, 1);`);
	try {
		await h.start();
		await eventually(() => h.messages.length === 1);
		assert.match(h.messages[0].content, /hello 界 🌍/);
		assert.equal(h.messages[0].details.status, "completed");
	} finally { await h.close(); }
});

test("stderr diagnostics keep the tail and cap disk logs", async () => {
	const h = await harness("process.stderr.write('x'.repeat(3 * 1024 * 1024) + '\\nFINAL FAILURE', () => process.exit(1));");
	try {
		await h.start();
		await eventually(() => h.messages.length === 1);
		assert.match(h.messages[0].content, /FINAL FAILURE/);
		const log = join(h.messages[0].details.artifactDir, "stderr.log");
		assert.ok(statSync(log).size < 2 * 1024 * 1024 + 100);
		assert.match(readFileSync(log, "utf8"), /Diagnostic log capped/);
	} finally { await h.close(); }
});

test("empty child output is a failure, not a successful job", async () => {
	const h = await harness("");
	try {
		await h.start();
		await eventually(() => h.messages.length === 1);
		assert.equal(h.messages[0].details.status, "failed");
		assert.match(h.messages[0].content, /without an assistant response/);
	} finally { await h.close(); }
});

test("launch-error renderer does not claim the subagent started", async () => {
	const h = await harness("");
	try {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const component = h.tools.get("subagent").renderResult(
			{ content: [{ type: "text", text: "Unknown subagent" }] }, {}, theme, { isError: true });
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /Unknown subagent/);
		assert.doesNotMatch(rendered, /started in background/);
	} finally { await h.close(); }
});

test("POSIX cancellation escalates against a SIGTERM-ignoring process group", { skip: process.platform === "win32" }, async () => {
	const proc = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {
		detached: true, stdio: ["ignore", "pipe", "ignore"],
	});
	try {
		await once(proc.stdout!, "data");
		await terminateProcessTree(proc, 50);
		assert.equal(proc.signalCode, "SIGKILL");
	} finally { try { process.kill(-proc.pid!, "SIGKILL"); } catch {} }
});

test("POSIX descendants are killed even when the leader exits on SIGTERM", { skip: process.platform === "win32" }, async () => {
	const code = `const {spawn} = require('node:child_process');
		const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {stdio:['ignore','pipe','ignore']});
		child.stdout.once('data', () => console.log(child.pid)); setInterval(() => {}, 1000);`;
	const proc = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	let childPid: number | undefined;
	try {
		const [chunk] = await once(proc.stdout!, "data");
		childPid = Number(chunk.toString().trim());
		assert.ok(childPid > 0);
		await terminateProcessTree(proc, 50);
		await eventually(() => {
			try {
				// An orphan may briefly remain as a zombie awaiting init's reaper.
				const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
				return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
			} catch { return true; }
		});
	} finally {
		try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
		if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
	}
});

test("unacknowledged async send failures can retry in an idle, empty queue without reload", async () => {
	const h = await harness(`console.log(${JSON.stringify(answer("retry without reload"))});`, { ack: false });
	try {
		const { details } = await h.start();
		await eventually(() => h.messages.length === 1);
		h.setQueue(true, true);
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 1, "pending messages must block retry");
		h.setQueue(true, false);
		h.setAck(true);
		await h.command(`retry ${details.id}`);
		assert.equal(h.messages.length, 2);
		assert.equal((await h.status(details.id)).delivery, "delivered");
	} finally { await h.close(); }
});

test("old running and queued records recover by ID outside the recent-history window", async () => {
	const h = await harness("");
	try {
		const store = new JobStore(join(h.dir, "state"), "session-one");
		const ids: string[] = [];
		for (let i = 0; i < 55; i++) {
			const id = `subagent-${randomUUID()}`;
			ids.push(id);
			store.create(id);
			store.save({ version: 1, id, sessionId: "session-one", runtimeId: "old-runtime", originLeafId: null,
				name: "old", agent: "scout", task: "old task", cwd: h.dir, startedAt: i, lastActivityAt: i,
				lastActivity: "old", timeoutSeconds: 10, status: i === 0 ? "running" : "completed",
				delivery: "queued", deliveryAttempts: 1, output: createAgentOutputState() });
		}
		await h.reload();
		assert.equal((await h.status(ids[0])).status, "failed");
		assert.equal((await h.status(ids[1])).delivery, "pending");
		await h.command(`retry ${ids[1]}`);
		assert.equal(h.messages.length, 1);
		assert.equal((await h.status(ids[1])).delivery, "delivered");
	} finally { await h.close(); }
});

function processIsGoneOrZombie(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch { return true; }
}

test("normal completion cleans up background descendants before releasing ownership", { skip: process.platform !== "linux" }, async () => {
	const code = `const {spawn} = require('node:child_process');
		const fs = require('node:fs');
		const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);"], {stdio:'ignore'});
		fs.writeFileSync('child.pid', String(child.pid));
		const timer = setInterval(() => { if (fs.existsSync('ready')) { clearInterval(timer); console.log(${JSON.stringify(answer("done"))}); child.unref(); } }, 10);`;
	const h = await harness(code);
	let pid: number | undefined;
	try {
		await h.start();
		await eventually(() => existsSync(join(h.dir, "child.pid")));
		pid = Number(readFileSync(join(h.dir, "child.pid"), "utf8"));
		await eventually(() => h.messages.length === 1);
		assert.equal(h.messages[0].details.status, "completed");
		assert.ok(processIsGoneOrZombie(pid));
	} finally {
		await h.close();
		if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
	}
});

test("shutdown waits for an already-requested descendant kill escalation", { skip: process.platform !== "linux" }, async () => {
	const code = `const {spawn} = require('node:child_process'); const fs = require('node:fs');
		const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);"], {stdio:'ignore'});
		fs.writeFileSync('child.pid', String(child.pid)); setInterval(() => {}, 1000);`;
	const h = await harness(code);
	let pid: number | undefined;
	try {
		const { details } = await h.start();
		await eventually(() => existsSync(join(h.dir, "ready")));
		pid = Number(readFileSync(join(h.dir, "child.pid"), "utf8"));
		const cancellation = h.call("subagent_cancel", { id: details.id });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await h.handlers.get("session_shutdown")!({}, h.ctx);
		await cancellation;
		assert.ok(processIsGoneOrZombie(pid));
		assert.equal(h.messages.length, 0, "shutdown must suppress in-flight completions");
		assert.equal((await h.status(details.id)).status, "cancelled");
	} finally {
		await h.close();
		if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
	}
});

test("job store rejects path traversal, ignores corrupt records, and bounds recent history", () => {
	const dir = mkdtempSync(join(tmpdir(), "async-subagents-store-"));
	try {
		const store = new JobStore(dir, "session");
		assert.throws(() => store.jobDir("../../escape"), /Invalid/);
		for (let i = 0; i < 55; i++) {
			const id = `subagent-${randomUUID()}`;
			store.create(id);
			store.save({ version: 1, id, sessionId: "session", originLeafId: null, name: "test", agent: "scout", task: "task", cwd: dir,
				startedAt: i, lastActivityAt: i, lastActivity: "test", timeoutSeconds: 10, status: "completed", delivery: "delivered",
				deliveryAttempts: 1, output: createAgentOutputState() });
		}
		const broken = `subagent-${randomUUID()}`;
		store.create(broken); writeFileSync(store.file(broken, "job.json"), "not json");
		assert.equal(store.load(broken), undefined);
		assert.equal(store.recent().length, 50);
		assert.equal(store.recent()[0].startedAt, 54);
		assert.equal(new JobStore(dir, "other-session").recent().length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
