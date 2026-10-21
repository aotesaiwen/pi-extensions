import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import asyncSubagents, {
	buildPiArgs,
	consumeAgentEvent,
	createAgentOutputState,
	formatCompletionMessage,
	parseAgentDefinition,
} from "../extensions/async-subagents/index.ts";

test("parseAgentDefinition reads profile frontmatter and prompt", () => {
	const agent = parseAgentDefinition(
		`---
name: tester
description: Test profile
tools: read, grep, read
model: provider/model
thinking: low
---

Do the test task.`,
		"/tmp/tester.md",
	);

	assert.ok(agent);
	assert.equal(agent.name, "tester");
	assert.equal(agent.description, "Test profile");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.equal(agent.model, "provider/model");
	assert.equal(agent.thinking, "low");
	assert.equal(agent.systemPrompt, "Do the test task.");
});

test("parseAgentDefinition uses safe defaults when tools are omitted", () => {
	const agent = parseAgentDefinition(
		`---
name: read-only
---

Investigate.`,
		"/tmp/read-only.md",
	);

	assert.ok(agent);
	assert.deepEqual(agent.tools, ["read", "grep", "find", "ls"]);
});

test("consumeAgentEvent tracks the final assistant message and usage", () => {
	const state = createAgentOutputState();
	consumeAgentEvent(state, { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
	consumeAgentEvent(state, { type: "tool_execution_end", toolName: "read" });
	consumeAgentEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Working..." }],
			usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.01 } },
			model: "provider/model",
		},
	});
	consumeAgentEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Final answer" }],
			usage: { input: 20, output: 5, cacheRead: 6, cacheWrite: 7, cost: { total: 0.02 } },
			model: "provider/model",
		},
	});

	assert.equal(state.text, "Final answer");
	assert.equal(state.turns, 2);
	assert.equal(state.toolCount, 1);
	assert.equal(state.model, "provider/model");
	assert.deepEqual(
		{ ...state.usage, cost: undefined },
		{
			input: 30,
			output: 7,
			cacheRead: 9,
			cacheWrite: 11,
			cost: undefined,
		},
	);
	assert.equal(state.usage.cost, 0.03);
});

test("formatCompletionMessage distinguishes success and failure", () => {
	const job = { name: "scout", agent: "scout", task: "Map\nthe code", startedAt: 0 };
	const success = createAgentOutputState();
	success.text = "## Files Found\n- a.ts";

	const successText = formatCompletionMessage(job, success, 0, undefined, 1_500);
	assert.match(successText, /completed in 1\.5s/);
	assert.match(successText, /Task: Map the code/);
	assert.match(successText, /## Files Found/);
	assert.match(successText, /This is the subagent's result/);

	const failure = createAgentOutputState();
	failure.error = "provider failed";
	const failureText = formatCompletionMessage(job, failure, 1, "pi exited with code 1", 2_000);
	assert.match(failureText, /failed after 2\.0s/);
	assert.match(failureText, /Error: pi exited with code 1/);
});

test("buildPiArgs creates an isolated non-interactive child invocation", () => {
	const agent = {
		name: "scout",
		description: "",
		tools: ["read", "grep"],
		systemPrompt: "You are a scout.",
		filePath: "/tmp/scout.md",
	};
	const built = buildPiArgs(agent, "Find the auth code", "/tmp", "provider/model");
	try {
		assert.ok(built.args.includes("--mode"));
		assert.equal(built.args[built.args.indexOf("--mode") + 1], "json");
		assert.ok(built.args.includes("-p"));
		assert.ok(built.args.includes("--no-session"));
		assert.ok(built.args.includes("--no-extensions"));
		assert.ok(built.args.includes("--no-mcp"));
		assert.equal(built.args[built.args.indexOf("--tools") + 1], "read,grep");
		assert.equal(built.args[built.args.indexOf("--model") + 1], "provider/model");
		assert.equal(built.args.at(-1), "Task: Find the auth code");
		assert.ok(existsSync(join(built.tempDir, "system.md")));
	} finally {
		rmSync(built.tempDir, { recursive: true, force: true });
	}
});

test("subagent tool returns immediately and delivers the child result", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-async-subagent-test-"));
	const fakePi = join(dir, "fake-pi.js");
	writeFileSync(
		fakePi,
		`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"mock child result"}],usage:{input:1,output:2,cost:{total:0}}}}));\n`,
	);

	let subagentTool: any;
	let delivered: { message: any; options: any } | undefined;
	const handlers = new Map<string, Function>();
	asyncSubagents({
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerTool(definition: any) {
			if (definition.name === "subagent") subagentTool = definition;
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage(message: any, options: any) {
			delivered = { message, options };
		},
	} as any);

	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		model: { provider: "mock", id: "model" },
		sessionManager: { getSessionId: () => "test", getLeafId: () => null, getBranch: () => [] },
		ui: {
			notify() {},
			setStatus() {},
		},
	};
	const oldPi = process.env.PI_ASYNC_SUBAGENT_PI;
	const oldState = process.env.PI_ASYNC_SUBAGENT_STATE_DIR;
	process.env.PI_ASYNC_SUBAGENT_STATE_DIR = join(dir, "state");
	process.env.PI_ASYNC_SUBAGENT_PI = fakePi;
	try {
		await handlers.get("session_start")!({}, ctx);
		const result = await subagentTool.execute(
			"test-call",
			{ agent: "scout", task: "Return a mock result" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.status, "running");
		assert.match(result.content[0].text, /running in the background/);

		const deadline = Date.now() + 5_000;
		while (!delivered && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.ok(delivered, "subagent result was not delivered");
		assert.equal(delivered.message.customType, "async_subagent_result");
		assert.match(delivered.message.content, /mock child result/);
		assert.deepEqual(delivered.options, { triggerTurn: true, deliverAs: "steer" });
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
		if (oldState === undefined) delete process.env.PI_ASYNC_SUBAGENT_STATE_DIR;
		else process.env.PI_ASYNC_SUBAGENT_STATE_DIR = oldState;
		if (oldPi === undefined) delete process.env.PI_ASYNC_SUBAGENT_PI;
		else process.env.PI_ASYNC_SUBAGENT_PI = oldPi;
		rmSync(dir, { recursive: true, force: true });
	}
});
