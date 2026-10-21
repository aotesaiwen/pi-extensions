import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentOutputState {
	text: string;
	error?: string;
	model?: string;
	turns: number;
	toolCount: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface JobRecord {
	version: 1;
	id: string;
	sessionId: string;
	runtimeId?: string;
	originLeafId: string | null;
	name: string;
	agent: string;
	task: string;
	cwd: string;
	startedAt: number;
	finishedAt?: number;
	lastActivityAt: number;
	lastActivity: string;
	timeoutSeconds: number;
	status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
	delivery: "pending" | "queued" | "delivered";
	deliveryError?: string;
	deliveryAttempts: number;
	suppressDelivery?: boolean;
	exitCode?: number;
	exitSignal?: string;
	error?: string;
	artifactError?: string;
	output: AgentOutputState;
}

export const RECENT_JOB_LIMIT = 50;
const JOB_ID = /^subagent-[a-f0-9-]{36}$/;

/** Session-scoped, private artifacts, separate from the model's conversation context. */
export class JobStore {
	readonly directory: string;
	readonly sessionId: string;

	constructor(root: string, sessionId: string) {
		this.sessionId = sessionId;
		this.directory = path.join(root, createHash("sha256").update(sessionId).digest("hex"));
	}

	jobDir(id: string): string {
		if (!JOB_ID.test(id)) throw new Error("Invalid subagent job ID.");
		return path.join(this.directory, id);
	}

	file(id: string, name: "job.json" | "output.md" | "stderr.log" | "events.jsonl"): string {
		return path.join(this.jobDir(id), name);
	}

	create(id: string): void {
		fs.mkdirSync(this.jobDir(id), { recursive: true, mode: 0o700 });
	}

	save(job: JobRecord): void {
		const target = this.file(job.id, "job.json");
		const temporary = `${target}.tmp`;
		// Keep only a bounded preview in metadata; output.md holds the full final answer.
		const record = { ...job, output: { ...job.output, text: job.output.text.slice(0, 120_000) } };
		fs.writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, target);
	}

	load(id: string): JobRecord | undefined {
		try {
			const record = JSON.parse(fs.readFileSync(this.file(id, "job.json"), "utf8"));
			if (
				record.version !== 1 || record.id !== id || record.sessionId !== this.sessionId ||
				!Number.isFinite(record.startedAt) || typeof record.name !== "string" ||
				typeof record.agent !== "string" || typeof record.task !== "string" ||
				!record.output || typeof record.output.text !== "string" || !record.output.usage ||
				!["running", "completed", "failed", "cancelled", "timed_out"].includes(record.status) ||
				!["pending", "queued", "delivered"].includes(record.delivery)
			) return undefined;
			return record as JobRecord;
		} catch {
			return undefined;
		}
	}

	recent(): JobRecord[] {
		if (!fs.existsSync(this.directory)) return [];
		// Scan incrementally rather than materializing every output preview in memory.
		const records: JobRecord[] = [];
		for (const id of fs.readdirSync(this.directory)) {
			if (!JOB_ID.test(id)) continue;
			const record = this.load(id);
			if (!record) continue;
			records.push(record);
			records.sort((a, b) => b.startedAt - a.startedAt);
			if (records.length > RECENT_JOB_LIMIT) records.pop();
		}
		return records;
	}
}
