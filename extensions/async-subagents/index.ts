/**
 * Async subagents for pi.
 *
 * Each subagent runs as a separate non-interactive `pi` process in the
 * background. The `subagent` tool returns immediately; when the child exits,
 * its final assistant message is delivered back to the main session as a
 * custom message that wakes the agent for a new turn.
 *
 * No tmux, panes, or direct user interaction with the child are required.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JobStore, RECENT_JOB_LIMIT, type AgentOutputState, type JobRecord } from "./jobs.ts";
import { terminateProcessTree } from "./process.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_AGENTS_DIR = path.join(EXT_DIR, "agents");
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const MAX_OUTPUT_CHARS = 120_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}
const TASK_FILE_THRESHOLD = 8_000;
const STATE_KEY = Symbol.for("pi-async-subagents/state");

interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	filePath: string;
}

interface SubagentJob {
	record: JobRecord;
	store: JobStore;
	stop: (reason: "cancelled" | "timed_out", message: string, suppressDelivery?: boolean) => Promise<void>;
}

interface RuntimeState {
	jobs: Map<string, SubagentJob>;
	disposed: boolean;
	shutdown?: () => Promise<void>;
}

interface SubagentParams {
	agent: string;
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
	timeoutSeconds?: number;
}

function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const configured = process.env.PI_ASYNC_SUBAGENT_PI?.trim();
	if (configured) {
		if (/\.(?:mjs|cjs|js)$/i.test(configured)) {
			return { command: process.execPath, baseArgs: [configured] };
		}
		return { command: configured, baseArgs: [] };
	}

	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
	if (!match) return undefined;
	return match[1].trim().replace(/^([\"'])(.*)\1$/, "$2");
}

export function parseAgentDefinition(content: string, filePath: string): AgentConfig | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return null;

	const frontmatter = match[1];
	const body = content.slice(match[0].length).trim();
	const fallbackName = path.basename(filePath, path.extname(filePath));
	const name = frontmatterValue(frontmatter, "name") || fallbackName;
	const tools = (frontmatterValue(frontmatter, "tools") || "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	return {
		name,
		description: frontmatterValue(frontmatter, "description") || "",
		tools: tools.length > 0 ? [...new Set(tools)] : DEFAULT_TOOLS,
		model: frontmatterValue(frontmatter, "model") || undefined,
		thinking: frontmatterValue(frontmatter, "thinking") || undefined,
		systemPrompt:
			body ||
			`You are the ${name} subagent. Complete the task autonomously and return a self-contained final answer.`,
		filePath,
	};
}

function findAgentFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort()
			.map((entry) => path.join(dir, entry));
	} catch {
		return [];
	}
}

function discoverAgents(cwd: string): AgentConfig[] {
	const agents = new Map<string, AgentConfig>();
	// Higher-priority directories are visited last and overwrite lower ones.
	const dirs = [
		BUILTIN_AGENTS_DIR,
		path.join(getAgentConfigDir(), "agents"),
		path.join(cwd, ".pi", "agents"),
	];

	for (const dir of dirs) {
		for (const filePath of findAgentFiles(dir)) {
			try {
				const agent = parseAgentDefinition(fs.readFileSync(filePath, "utf-8"), filePath);
				if (agent) agents.set(agent.name, agent);
			} catch {}
		}
	}

	return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function customToolExtension(tool: string): string | undefined {
	const candidates = [
		path.join(getAgentConfigDir(), "extensions", tool.replace(/_/g, "-"), "index.ts"),
		path.join(getAgentConfigDir(), "extensions", tool.replace(/_/g, "-"), "index.js"),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveAgentTools(agent: AgentConfig): { tools: string[]; extensionPaths: string[] } {
	const extensionPaths = new Set<string>();
	const missing: string[] = [];

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) continue;
		const extensionPath = customToolExtension(tool);
		if (extensionPath) extensionPaths.add(extensionPath);
		else missing.push(tool);
	}

	if (missing.length > 0) {
		throw new Error(
			`Agent "${agent.name}" requires unavailable tool${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
				`Install the matching extension under ${path.join(getAgentConfigDir(), "extensions")} or edit ${agent.filePath}.`,
		);
	}

	return { tools: agent.tools, extensionPaths: [...extensionPaths] };
}

export function createAgentOutputState(): AgentOutputState {
	return {
		text: "",
		turns: 0,
		toolCount: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("\n");
}

export function consumeAgentEvent(state: AgentOutputState, event: unknown): void {
	if (typeof event !== "object" || event === null) return;
	const record = event as Record<string, any>;

	if (record.type === "tool_execution_start") {
		state.toolCount++;
		return;
	}

	if (record.type === "auto_retry_end") {
		if (record.success === true) state.error = undefined;
		else if (record.success === false) state.error = record.finalError || "Automatic retries exhausted.";
		return;
	}

	if (record.type !== "message_end" || !record.message || record.message.role !== "assistant") return;
	const message = record.message;
	state.turns++;
	if (typeof message.model === "string") state.model = message.model;
	if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
		state.error = message.errorMessage.trim();
	} else if (message.stopReason === "error") {
		state.error = "The assistant turn ended with an error.";
	} else if (message.stopReason === "aborted") {
		state.error = "The assistant turn was aborted.";
	} else {
		state.error = undefined;
	}

	const usage = message.usage;
	if (usage) {
		state.usage.input += Number(usage.input) || 0;
		state.usage.output += Number(usage.output) || 0;
		state.usage.cacheRead += Number(usage.cacheRead) || 0;
		state.usage.cacheWrite += Number(usage.cacheWrite) || 0;
		state.usage.cost += Number(usage.cost?.total) || 0;
	}

	const text = extractText(message.content).trim();
	// Preserve earlier text only as partial output on failure, never as a stale final answer.
	if (text || !state.error) state.text = text;
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1_000)}s`;
}

function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Subagent output truncated]`;
}

export function formatCompletionMessage(
	job: Pick<JobRecord, "name" | "agent" | "task" | "startedAt"> & Partial<Pick<JobRecord, "status">>,
	output: AgentOutputState,
	exitCode: number,
	error: string | undefined,
	durationMs: number,
	outputPath?: string,
): string {
	const failed = exitCode !== 0 || Boolean(error) || Boolean(output.error) || job.status === "cancelled" || job.status === "timed_out";
	const outcome = job.status === "cancelled" ? "was cancelled" : job.status === "timed_out" ? "timed out" : "failed";
	const header = failed
		? `Sub-agent "${job.name}" (${job.agent}) ${outcome} after ${formatDuration(durationMs)}.`
		: `Sub-agent "${job.name}" (${job.agent}) completed in ${formatDuration(durationMs)}.`;
	const lines = [header, `Task: ${job.task.replace(/\s+/g, " ").slice(0, 500)}`, ""];

	if (failed) {
		const reason = error || output.error || `child process exited with code ${exitCode}`;
		lines.push(`Error: ${reason.slice(0, MAX_STDERR_CHARS)}`);
		if (output.text) lines.push("", "Partial output:", truncateOutput(output.text));
	} else {
		lines.push(truncateOutput(output.text) || "(The subagent finished without a text result.)");
	}
	if (outputPath) lines.push("", `Full output: ${outputPath}`);

	lines.push(
		"",
		"This is the subagent's result. Continue the user's task using it; do not invent additional subagent output.",
	);
	return lines.join("\n");
}

function uniqueJobName(jobs: Map<string, SubagentJob>, requested: string): string {
	const base = requested.trim() || "subagent";
	let name = base;
	let suffix = 2;
	while ([...jobs.values()].some((job) => job.record.name === name)) {
		name = `${base}-${suffix++}`;
	}
	return name;
}

export function buildPiArgs(
	agent: AgentConfig,
	task: string,
	_cwd: string,
	model?: string,
	inheritedModel?: string,
): { command: string; args: string[]; tempDir: string } {
	const pi = resolvePiBinary();
	const { tools, extensionPaths } = resolveAgentTools(agent);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-subagent-"));
	try {
		const promptPath = path.join(tempDir, "system.md");
		fs.writeFileSync(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });

		const args = [
			...pi.baseArgs,
			"--mode", "json", "-p", "--no-session", "--no-extensions",
			"--no-skills", "--no-prompt-templates", "--no-mcp", "--no-themes",
			"--tools", tools.join(","),
		];
		for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);

		args.push("--append-system-prompt", promptPath);
		const selectedModel = model || agent.model || inheritedModel;
		if (selectedModel) args.push("--model", selectedModel);
		if (agent.thinking) args.push("--thinking", agent.thinking);

		if (task.length > TASK_FILE_THRESHOLD) {
			const taskPath = path.join(tempDir, "task.md");
			fs.writeFileSync(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
			args.push(`@${taskPath}`);
		} else {
			args.push(`Task: ${task}`);
		}
		return { command: pi.command, args, tempDir };
	} catch (error) {
		cleanupTempDir(tempDir);
		throw error;
	}
}

function cleanupTempDir(tempDir: string | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}
}

export default function asyncSubagents(pi: ExtensionAPI) {
	const previous = (globalThis as any)[STATE_KEY] as RuntimeState | undefined;
	const state: RuntimeState = { jobs: new Map(), disposed: false };
	(globalThis as any)[STATE_KEY] = state;
	let latestCtx: ExtensionContext | undefined;
	let store: JobStore | undefined;
	const runtimeId = randomUUID();
	const recent = new Map<string, JobRecord>();
	const maxConcurrent = positiveInteger(process.env.PI_ASYNC_SUBAGENT_MAX, 4, 64);
	const defaultTimeout = positiveInteger(process.env.PI_ASYNC_SUBAGENT_TIMEOUT_SECONDS, 600, 86_400);

	function notify(text: string, level: "info" | "warning" | "error" = "info"): void {
		try { if (latestCtx?.hasUI) latestCtx.ui.notify(text, level); } catch {}
	}

	function remember(record: JobRecord): void {
		if (record.sessionId !== store?.sessionId) return;
		recent.set(record.id, record);
		const finished = [...recent.values()].filter((job) => !state.jobs.has(job.id))
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const job of finished.slice(RECENT_JOB_LIMIT)) recent.delete(job.id);
	}

	function save(record: JobRecord, target = store): void {
		try { target?.save(record); }
		catch (error) {
			record.artifactError = `Could not save job metadata: ${String(error)}`;
			notify(record.artifactError, "error");
		}
		remember(record);
	}

	function updateStatus(): void {
		if (!latestCtx?.hasUI) return;
		const running = state.jobs.size;
		const pending = [...recent.values()].filter((job) => job.status !== "running" && job.delivery !== "delivered").length;
		const parts = [];
		if (running) parts.push(`${running} subagent${running === 1 ? "" : "s"} running`);
		if (pending) parts.push(`${pending} result${pending === 1 ? "" : "s"} awaiting delivery`);
		try { latestCtx.ui.setStatus("async-subagents", parts.join(" · ") || undefined); } catch {}
	}

	function wasDelivered(record: JobRecord): boolean {
		return latestCtx?.sessionManager.getBranch().some((entry) => entry.type === "custom_message" &&
			entry.customType === "async_subagent_result" && (entry.details as { id?: string } | undefined)?.id === record.id) ?? false;
	}

	function recover(record: JobRecord): void {
		if (record.runtimeId === runtimeId) return;
		if (record.status === "running") {
			record.status = "failed";
			record.finishedAt = Date.now();
			record.error = "Previous runtime ended without recording completion; child state is unknown.";
			record.suppressDelivery = true;
		}
		record.delivery = wasDelivered(record) ? "delivered" : "pending";
		record.deliveryError = record.delivery === "pending"
			? "Result not present on the current branch. Inspect or retry with /subagents." : undefined;
		record.runtimeId = runtimeId;
		save(record);
	}

	function findJob(id: string): JobRecord {
		const record = state.jobs.get(id)?.record || recent.get(id) || store?.load(id);
		if (!record || record.sessionId !== store?.sessionId) throw new Error(`Unknown subagent job: ${id}`);
		// Older records outside the recent-history window recover lazily by ID.
		recover(record);
		return record;
	}

	function onOriginBranch(record: JobRecord, ctx: ExtensionContext): boolean {
		return record.originLeafId === null || ctx.sessionManager.getBranch().some((entry) => entry.id === record.originLeafId);
	}

	function snapshot(record: JobRecord) {
		return {
			id: record.id, sessionId: record.sessionId, name: record.name, agent: record.agent,
			status: record.status, delivery: record.delivery, deliveryAttempts: record.deliveryAttempts,
			deliveryError: record.deliveryError, error: record.error, artifactError: record.artifactError,
			cwd: record.cwd, startedAt: record.startedAt, finishedAt: record.finishedAt,
			durationMs: (record.finishedAt || Date.now()) - record.startedAt,
			lastActivityAt: record.lastActivityAt, lastActivity: record.lastActivity,
			timeoutSeconds: record.timeoutSeconds, model: record.output.model,
			turns: record.output.turns, toolCount: record.output.toolCount, usage: record.output.usage,
			exitCode: record.exitCode, exitSignal: record.exitSignal,
			artifactDir: store?.jobDir(record.id),
		};
	}

	function deliver(record: JobRecord, explicit = false): void {
		if (!latestCtx || !store || state.disposed || record.sessionId !== store.sessionId) return;
		if (record.status === "running") throw new Error("The subagent is still running.");
		if (explicit && record.delivery === "queued") {
			if (wasDelivered(record)) record.delivery = "delivered";
			else if (latestCtx.isIdle() && !latestCtx.hasPendingMessages()) {
				// A failed async send cannot throw through Pi's void API. Retry only
				// once both the transcript and the idle/empty queue rule out duplication.
				record.delivery = "pending";
			}
			save(record);
		}
		if (record.delivery === "delivered" || record.delivery === "queued") {
			if (explicit) throw new Error(`Result is already ${record.delivery}; it will not be sent twice. Retry an unacknowledged result when Pi is idle and its message queue is empty.`);
			return;
		}
		if (!explicit && (record.suppressDelivery || !onOriginBranch(record, latestCtx))) {
			record.deliveryError = "Automatic delivery withheld after shutdown or branch change; use /subagents retry <id> to deliver here.";
			save(record);
			updateStatus();
			return;
		}
		const outputPath = store.file(record.id, "output.md");
		const hasOutput = fs.existsSync(outputPath);
		let output = record.output;
		// Re-read artifacts on manual recovery; metadata contains only a preview.
		if (explicit && hasOutput) output = { ...output, text: fs.readFileSync(outputPath, "utf8") };
		const content = formatCompletionMessage(record, output, record.exitCode ?? 1, record.error,
			(record.finishedAt || Date.now()) - record.startedAt, hasOutput ? outputPath : undefined) +
			(record.artifactError ? `\nArtifact warning: ${record.artifactError}` : "");
		record.delivery = "queued";
		record.deliveryError = undefined;
		record.deliveryAttempts++;
		save(record);
		try {
			pi.sendMessage({
				customType: "async_subagent_result", content, display: true,
				details: { ...snapshot(record), outputPath: hasOutput ? outputPath : undefined },
			}, { triggerTurn: true, deliverAs: "steer" });
			// sendMessage is void. Only message_end acknowledges actual delivery.
		} catch (error) {
			record.delivery = "pending";
			record.deliveryError = String(error);
			save(record);
			notify(`Subagent ${record.id} result saved but not delivered. Use /subagents retry ${record.id}.`, "warning");
		}
		updateStatus();
	}

	function startJob(agent: AgentConfig, params: SubagentParams, ctx: ExtensionContext, cwd: string): JobRecord {
		if (!store || state.disposed) throw new Error("Subagent session is not active.");
		const timeoutSeconds = params.timeoutSeconds ?? defaultTimeout;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
			throw new Error("timeoutSeconds must be an integer between 1 and 86400.");
		}
		const built = buildPiArgs(agent, params.task, cwd, params.model,
			ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const jobStore = store;
		const record: JobRecord = {
			version: 1, id: `subagent-${randomUUID()}`, sessionId: store.sessionId, runtimeId,
			originLeafId: ctx.sessionManager.getLeafId(), name: uniqueJobName(state.jobs, params.name || agent.name),
			agent: agent.name, task: params.task, cwd, startedAt: Date.now(),
			lastActivityAt: Date.now(), lastActivity: "starting", timeoutSeconds,
			status: "running", delivery: "pending", deliveryAttempts: 0, output: createAgentOutputState(),
		};
		let proc: ChildProcess;
		try {
			jobStore.create(record.id);
			jobStore.save(record);
			proc = spawn(built.command, built.args, {
				cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env,
				detached: process.platform !== "win32", windowsHide: true,
			});
		} catch (error) {
			cleanupTempDir(built.tempDir);
			record.status = "failed";
			record.finishedAt = Date.now();
			record.error = String(error);
			save(record, jobStore);
			throw error;
		}

		const decoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;
		let protocolError: string | undefined;
		let spawnError: string | undefined;
		let stopping: Promise<void> | undefined;
		let treeCleanup: Promise<void> | undefined;
		const cleanupTree = () => treeCleanup ??= terminateProcessTree(proc);
		let stopReason: "cancelled" | "timed_out" | undefined;
		const logBytes = { "events.jsonl": 0, "stderr.log": 0 };

		const log = (name: keyof typeof logBytes, chunk: Buffer) => {
			if (logBytes[name] >= MAX_LOG_BYTES) return;
			const remaining = MAX_LOG_BYTES - logBytes[name];
			try {
				fs.appendFileSync(jobStore.file(record.id, name), chunk.subarray(0, remaining), { mode: 0o600 });
				logBytes[name] += Math.min(chunk.length, remaining);
				if (chunk.length >= remaining) fs.appendFileSync(jobStore.file(record.id, name), "\n[Diagnostic log capped at 2 MiB]\n");
			} catch (error) {
				record.artifactError = `Diagnostic log unavailable: ${String(error)}`;
				logBytes[name] = MAX_LOG_BYTES;
			}
		};

		const processLine = (line: string) => {
			if (!line.trim() || protocolError) return;
			if (line.length > MAX_EVENT_CHARS) {
				protocolError = "Child JSON event exceeded the 16 Mi-character safety limit.";
				return;
			}
			try {
				const event = JSON.parse(line);
				consumeAgentEvent(record.output, event);
				if (event?.type === "tool_execution_start") record.lastActivity = `tool: ${String(event.toolName).slice(0, 100)}`;
				else if (event?.type === "message_end") record.lastActivity = "assistant turn finished";
			} catch {
				// Non-JSON diagnostics are retained in events.jsonl, not treated as results.
			}
		};

		const finalize = (code: number | null, signal?: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			processLine(stdoutBuffer + decoder.end());
			stdoutBuffer = "";
			stderrBuffer = (stderrBuffer + stderrDecoder.end()).slice(-MAX_STDERR_CHARS);
			cleanupTempDir(built.tempDir);
			record.finishedAt = Date.now();
			record.exitCode = code ?? 1;
			record.exitSignal = signal || undefined;
			record.error ||= spawnError || protocolError || record.output.error ||
				(code !== 0 ? stderrBuffer.trim() || `pi exited with ${signal || `code ${code ?? 1}`}` : undefined);
			if (!record.error && record.output.turns === 0) record.error = "Child exited without an assistant response.";
			record.status = protocolError ? "failed" : stopReason || (record.error ? "failed" : "completed");
			try {
				fs.writeFileSync(jobStore.file(record.id, "output.md"), record.output.text, { encoding: "utf8", mode: 0o600 });
			} catch (error) { record.artifactError = `Could not save full output: ${String(error)}`; }
			state.jobs.delete(record.id);
			save(record, jobStore);
			if (!state.disposed) deliver(record);
			// Full output is now on disk; keep memory bounded for recent jobs.
			record.output.text = record.output.text.slice(0, MAX_OUTPUT_CHARS);
			updateStatus();
		};

		const stop: SubagentJob["stop"] = (reason, message, suppressDelivery = false) => {
			if (suppressDelivery) record.suppressDelivery = true;
			if (settled) return Promise.resolve();
			if (stopping) { save(record, jobStore); return stopping; }
			stopReason = reason;
			record.error = message;
			record.lastActivity = reason === "timed_out" ? "timeout; terminating" : "cancelling";
			save(record, jobStore);
			stopping = cleanupTree().then(() => {
				// Escaped descendants can hold pipes open; don't retain the slot forever.
				if (!settled) {
					proc.stdout?.destroy();
					proc.stderr?.destroy();
					proc.unref();
					finalize(proc.exitCode, proc.signalCode);
				}
			});
			return stopping;
		};

		const timeout = setTimeout(() => {
			void stop("timed_out", `Exceeded the ${timeoutSeconds}s wall-clock timeout.`);
		}, timeoutSeconds * 1_000);
		timeout.unref();
		state.jobs.set(record.id, { record, store: jobStore, stop });
		remember(record);
		updateStatus();

		proc.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			record.lastActivityAt = Date.now();
			log("events.jsonl", chunk);
			if (protocolError) return;
			stdoutBuffer += decoder.write(chunk);
			let newline: number;
			while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
				processLine(stdoutBuffer.slice(0, newline));
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
			}
			if (stdoutBuffer.length > MAX_EVENT_CHARS) protocolError = "Child JSON event exceeded the 16 Mi-character safety limit.";
			if (protocolError) { stdoutBuffer = ""; void stop("cancelled", protocolError); }
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			record.lastActivityAt = Date.now();
			log("stderr.log", chunk);
			stderrBuffer = (stderrBuffer + stderrDecoder.write(chunk)).slice(-MAX_STDERR_CHARS);
		});
		// Keep the slot and shutdown ownership until the tree, not just its leader,
		// has been cleaned up. This also catches background children on success.
		proc.on("close", (code, signal) => { void cleanupTree().then(() => finalize(code, signal)); });
		proc.on("error", (error) => {
			spawnError = error.message;
			void cleanupTree().then(() => finalize(1));
		});
		return record;
	}

	state.shutdown = async () => {
		state.disposed = true;
		const ctx = latestCtx;
		latestCtx = undefined;
		try { ctx?.ui.setStatus("async-subagents", undefined); } catch {}
		await Promise.all([...state.jobs.values()].map((job) =>
			job.stop("cancelled", "Session shut down or extension reloaded.", true)));
	};

	pi.on("session_start", async (_event, ctx) => {
		await previous?.shutdown?.();
		latestCtx = ctx;
		state.disposed = false;
		store = new JobStore(process.env.PI_ASYNC_SUBAGENT_STATE_DIR || path.join(getAgentConfigDir(), "async-subagents"),
			ctx.sessionManager.getSessionId());
		recent.clear();
		for (const record of store.recent()) recover(record);
		updateStatus();
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== "async_subagent_result") return;
		const details = message.details as { id?: string; sessionId?: string } | undefined;
		if (!details?.id || details.sessionId !== store?.sessionId) return;
		try {
			const record = findJob(details.id);
			record.delivery = "delivered";
			record.deliveryError = undefined;
			save(record);
			updateStatus();
		} catch { /* Foreign or expired job, not an acknowledgement for this runtime. */ }
	});

	pi.on("session_tree", (_event, ctx) => { latestCtx = ctx; updateStatus(); });
	pi.on("session_shutdown", () => state.shutdown!());

	function statusText(record: JobRecord): string {
		const duration = formatDuration((record.finishedAt || Date.now()) - record.startedAt);
		return `${record.id} · ${record.name} (${record.agent}) · ${record.status} · ${duration}` +
			` · ${record.output.toolCount} tools · $${record.output.usage.cost.toFixed(4)} · ${record.delivery}` +
			`\n  Last: ${record.lastActivity}${record.error ? `\n  Error: ${record.error}` : ""}` +
			(record.deliveryError ? `\n  Delivery: ${record.deliveryError}` : "");
	}

	function inspect(id?: string) {
		const jobs = id ? [findJob(id)] : [...recent.values()].sort((a, b) => b.startedAt - a.startedAt);
		const text = jobs.length ? jobs.map(statusText).join("\n\n") : "No subagent jobs in this session.";
		return {
			content: [{ type: "text" as const, text: text + (id && store ? `\nArtifacts: ${store.jobDir(id)}` : "") }],
			details: { jobs: jobs.map(snapshot) },
		};
	}

	async function cancel(id: string) {
		const record = findJob(id);
		const active = state.jobs.get(id);
		if (active) await active.stop("cancelled", "Cancelled by request.");
		return {
			content: [{ type: "text" as const, text: `Subagent ${id}: ${record.status}.` }],
			details: snapshot(record),
		};
	}

	pi.registerCommand("subagents", {
		description: "Inspect jobs: /subagents [id], cancel <id>, or retry <id> (undelivered results)",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (parts[0] === "cancel" && parts.length === 2) {
					const result = await cancel(parts[1]);
					notify(result.content[0].text);
				} else if (parts[0] === "retry" && parts.length === 2) {
					const record = findJob(parts[1]);
					deliver(record, true);
					notify(`Result ${record.id}: ${record.delivery}.`, record.delivery === "pending" ? "warning" : "info");
				} else if (parts.length === 0 || (parts.length === 1 && parts[0].startsWith("subagent-"))) {
					notify(inspect(parts[0]).content[0].text);
				} else throw new Error("Usage: /subagents [id] | cancel <id> | retry <id>");
			} catch (error) { notify(String(error), "error"); }
		},
	});

	pi.registerTool({
		name: "subagents_status",
		label: "Subagent Status",
		description: "Inspect running/recent jobs or one job by ID, including output artifact paths. For troubleshooting only; results arrive automatically, so do not poll.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Optional job ID returned by subagent." })) }),
		async execute(_id, params) { return inspect(params.id); },
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel Subagent",
		description: "Cancel a background subagent by job ID, terminating its process tree. Completed jobs are unchanged.",
		parameters: Type.Object({ id: Type.String({ description: "Job ID returned by subagent." }) }),
		async execute(_id, params) { return cancel(params.id); },
	});

	pi.registerTool({
		name: "subagent",
		label: "Async Subagent",
		description:
			"Start a background subagent with an isolated context. Returns immediately; the subagent's result is delivered automatically as a new message when it finishes. Use for parallel investigation or isolated implementation work.",
		promptSnippet:
			"Start a background subagent with a named agent profile and task. Continue other work while it runs; its result arrives automatically.",
		promptGuidelines: [
			"Choose a profile with the `agent` field; `name` is only a display label.",
			"After starting a subagent, continue other useful work or end your turn. Do not poll, wait in a loop, or invent its result.",
			"You can launch multiple independent subagents in the same turn; their results arrive separately.",
		],

		parameters: Type.Object({
			agent: Type.String({ description: "Agent profile to run, such as scout, researcher, or worker." }),
			task: Type.String({ description: "Self-contained task for the subagent. It has no access to this conversation." }),
			name: Type.Optional(Type.String({ description: "Optional display name; defaults to the agent name." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to the current directory." })),
			model: Type.Optional(Type.String({ description: "Optional model override, such as provider/model. Overrides the profile model." })),
			timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400, description: "Wall-clock timeout in seconds; defaults to 600 or PI_ASYNC_SUBAGENT_TIMEOUT_SECONDS." })),
		}),

		async execute(_toolCallId, params: SubagentParams, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Subagent launch was aborted.");
			latestCtx = ctx;
			const agents = discoverAgents(ctx.cwd);
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				const available = agents.map((candidate) => candidate.name).join(", ") || "(none)";
				throw new Error(`Unknown subagent "${params.agent}". Available agents: ${available}.`);
			}

			const running = state.jobs.size;
			if (running >= maxConcurrent) {
				throw new Error(
					`Too many running subagents (${running}/${maxConcurrent}). Continue other work until one finishes, cancel a job, or raise PI_ASYNC_SUBAGENT_MAX.`,
				);
			}

			const cwd = path.resolve(ctx.cwd, params.cwd || ".");
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				throw new Error(`Subagent working directory does not exist: ${cwd}`);
			}

			const job = startJob(agent, params, ctx, cwd);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Subagent "${job.name}" (${agent.name}) is running in the background. Job ID: ${job.id}. Timeout: ${job.timeoutSeconds}s. ` +
							`Continue with other work or end your turn; its result will arrive automatically as a new message. ` +
							`Do not invent or preemptively summarize its result.`,
					},
				],
				details: {
					id: job.id,
					name: job.name,
					agent: agent.name,
					task: job.task,
					cwd,
					status: job.status,
					timeoutSeconds: job.timeoutSeconds,
					artifactDir: store!.jobDir(job.id),
				},
			};
		},

		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const task = String(args.task || "").replace(/\s+/g, " ");
			const display = task.length > 90 ? `${task.slice(0, 87)}...` : task;
			component.setText(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", String(args.agent || "?")) +
					theme.fg("dim", ` — ${display}`),
			);
			return component;
		},

		renderResult(result, _options, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as { name?: string; agent?: string; status?: string } | undefined;
			if (context.isError || !details || details.status !== "running") {
				component.setText(theme.fg("error", extractText(result.content) || "Subagent did not start."));
				return component;
			}
			component.setText(
				theme.fg("success", "↗ ") +
					theme.fg("toolTitle", theme.bold(details?.name || "subagent")) +
					theme.fg("dim", ` (${details?.agent || "?"}) started in background`),
			);
			return component;
		},
	});

	pi.registerTool({
		name: "subagents_list",
		label: "List Subagents",
		description: "List available subagent profiles and their tools.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd);
			const text =
				agents.length === 0
					? "No subagent profiles found. Add Markdown profiles under ~/.pi/agent/agents or .pi/agents."
					: agents
							.map(
								(agent) =>
									`- ${agent.name}: ${agent.description || "No description"} (tools: ${agent.tools.join(", ")})`,
							)
							.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { agents: agents.map((agent) => ({ name: agent.name, description: agent.description, tools: agent.tools })) },
			};
		},
	});

	pi.registerMessageRenderer("async_subagent_result", (message, options, theme) => {
		const details = (message.details || {}) as {
			name?: string;
			agent?: string;
			status?: string;
			durationMs?: number;
			toolCount?: number;
			error?: string;
		};
		const failed = (details.status !== undefined && details.status !== "completed") || Boolean(details.error);
		const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header =
			`${icon} ${theme.fg("toolTitle", theme.bold(details.name || "subagent"))}` +
			theme.fg("dim", ` (${details.agent || "?"}) · ${formatDuration(details.durationMs || 0)}`);
		if (!options.expanded) return new Text(header, 0, 0);
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${header}\n\n${content}`, 0, 0);
	});
}
