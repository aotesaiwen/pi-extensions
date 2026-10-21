import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * POSIX children must be spawned with detached:true so their process group is ours.
 * `ChildProcess.killed` means a signal was sent, NOT that the child exited.
 * Keep the escalation timer if descendants survive the group leader.
 */
export function terminateProcessTree(proc: ChildProcess, graceMs = 3_000): Promise<void> {
	return new Promise((resolve) => {
		let closed = proc.exitCode !== null || proc.signalCode !== null;
		let done = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const groupExists = () => {
			if (!proc.pid) return false;
			if (process.platform === "win32") return !closed;
			try { process.kill(-proc.pid, 0); return true; }
			catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
		};
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(escalation);
			clearTimeout(deadline);
			proc.off("close", onClose);
			resolve();
		};
		const onClose = () => {
			closed = true;
			if (!groupExists()) finish();
		};
		const signal = (force: boolean) => {
			if (!proc.pid) return;
			if (process.platform === "win32") {
				const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(proc.pid), "/t", ...(force ? ["/f"] : [])], {
					stdio: "ignore", windowsHide: true,
				});
				killer.on("error", () => { try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} });
				return;
			}
			try { process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM"); }
			catch { try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
		};

		proc.on("close", onClose);
		if (!proc.pid || (closed && !groupExists())) { finish(); return; }
		signal(false);
		escalation = setTimeout(() => {
			if (groupExists()) signal(true);
			if (closed && !groupExists()) finish();
		}, graceMs);
		// Bound shutdown even if an escaped descendant holds a pipe open.
		deadline = setTimeout(finish, graceMs + 1_000);
		// Intentionally ref'ed: session shutdown must survive long enough to force-kill.
	});
}
