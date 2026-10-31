/**
 * Voice, debug console, security dashboard, SSH hosts, omp updates and the
 * plugin doctor.
 *
 * Session-bound commands go to the gui-bridge `misc` methods. `get_omp_update` drives the
 * system omp CLI directly: `omp update --check` reports the installed and latest versions
 * (honoring the user's channel and npm registry) with `ompUpdateEnv`, so stock checks this
 * omp's install, not another `omp` earlier on PATH. Installing is not here: a computer
 * updates its own omp through `OmpUpdater` (omp-updater.ts), a paired host's included
 * (`host.ompUpdate.now`).
 * `get_plugin_doctor` is stock `omp plugin doctor --json` (plugin directory,
 * manifest, node_modules, each plugin's version, tools, hooks and extensions).
 */
import type { RpcDoctorCheck } from "../../shared/rpc-types";
import { clearAgentWorktrees, listAgentWorktrees } from "../agent-worktrees";
import { ompUpdateEnv, parseUpdateCheck } from "../omp-runtime";
import { spawnPath } from "../shell-env";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

const UPDATE_CHECK_TIMEOUT_MS = 60_000;
/** Plain text from omp's chalk output, so the update report parses the same everywhere. */
const PLAIN_ENV = { NO_COLOR: "1", FORCE_COLOR: "0" };

function lastLines(text: string, count = 6): string {
	return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

const DOCTOR_TIMEOUT_MS = 60_000;
const DOCTOR_STATUS: Record<string, RpcDoctorCheck["status"]> = { ok: "ok", warning: "warning", error: "error" };

/** Stock's `DoctorCheck[]` (`extensibility/plugins/types.ts`), rows of another shape dropped. */
export function parseDoctorChecks(stdout: string): RpcDoctorCheck[] | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(data)) return null;
	const checks: RpcDoctorCheck[] = [];
	for (const row of data) {
		if (typeof row !== "object" || row === null) continue;
		const { name, status, message } = row as Record<string, unknown>;
		const known = typeof status === "string" ? DOCTOR_STATUS[status] : undefined;
		if (typeof name !== "string" || !known) continue;
		checks.push({ name, status: known, message: typeof message === "string" ? message : "" });
	}
	return checks;
}

async function pluginDoctor(ctx: LocalCommandContext) {
	// `--json` exits 0 even with failing checks; a non-zero exit means the command itself failed.
	const result = await ctx.omp.run(["plugin", "doctor", "--json"], {
		cwd: ctx.cwd,
		timeoutMs: DOCTOR_TIMEOUT_MS,
		env: PLAIN_ENV,
	});
	const checks = result.code === 0 ? parseDoctorChecks(result.stdout) : null;
	if (!checks) {
		throw new LocalCommandError(
			lastLines(result.stderr || result.stdout) || `omp plugin doctor exited with code ${result.code}`,
			"doctor_failed",
		);
	}
	return { checks, checkedAt: new Date().toISOString() };
}

async function checkOmpUpdate(ctx: LocalCommandContext) {
	const result = await ctx.omp.run(["update", "--check"], {
		cwd: ctx.cwd,
		timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
		env: { ...PLAIN_ENV, ...ompUpdateEnv(ctx.omp.bin, await spawnPath()) },
	});
	const parsed = result.code === 0 ? parseUpdateCheck(result.stdout) : null;
	if (!parsed) {
		throw new LocalCommandError(
			lastLines(result.stderr || result.stdout) || `omp update --check exited with code ${result.code}`,
			"update_check_failed",
		);
	}
	return {
		...parsed,
		updateAvailable: parsed.latestVersion !== parsed.currentVersion,
		checkedAt: new Date().toISOString(),
		distribution: "system" as const,
		installStrategy: "omp-update" as const,
	};
}

/** Forward to a gui-bridge method with the command's own fields as params. */
function viaBridge(method: string): LocalHandler {
	return ({ type: _type, id: _id, ...params }, ctx) => ctx.bridge.request(method, params);
}

export const handlers: Record<string, LocalHandler> = {
	transcribe_audio: viaBridge("transcribe_audio"),
	synthesize_speech: viaBridge("synthesize_speech"),
	stt_stream_start: viaBridge("stt_stream_start"),
	stt_stream_push: viaBridge("stt_stream_push"),
	stt_stream_stop: viaBridge("stt_stream_stop"),
	stt_stream_cancel: viaBridge("stt_stream_cancel"),
	tts_stream_start: viaBridge("tts_stream_start"),
	tts_stream_next: viaBridge("tts_stream_next"),
	tts_stream_cancel: viaBridge("tts_stream_cancel"),
	debug: viaBridge("debug"),
	// Preview panel agent browsing: stock's browser relay inside this tab's omp (gui-bridge browser-relay.ts).
	browser_relay_start: viaBridge("browser.relay_start"),
	browser_relay_stop: viaBridge("browser.relay_stop"),
	get_security_dashboard: viaBridge("security_dashboard"),
	get_security_scan: viaBridge("security_scan"),
	security_start: viaBridge("security_start"),
	security_cancel: viaBridge("security_cancel"),
	security_set_disposition: viaBridge("security_set_disposition"),
	security_validate: async (command, ctx) => {
		const { prompt } = await ctx.bridge.request<{ prompt: string }>("security_validation_prompt", {
			scanId: command.scanId,
			findingId: command.findingId,
		});
		// A normal user turn; while the agent streams it queues as a follow-up (fork parity).
		await ctx.send({ type: "prompt", message: prompt, streamingBehavior: "followUp" });
		return { accepted: true };
	},
	get_ssh_hosts: viaBridge("ssh_hosts"),
	ssh_manage: viaBridge("ssh_manage"),
	ssh_test: viaBridge("ssh_test"),
	get_omp_update: (_command, ctx) => checkOmpUpdate(ctx),
	get_plugin_doctor: (_command, ctx) => pluginDoctor(ctx),
	// Agent-managed worktrees under ~/.omp/wt (stock `omp worktree list|clear --json`, orphaned only).
	get_agent_worktrees: async (_command, ctx) => ({ entries: await listAgentWorktrees(ctx.omp, ctx.cwd) }),
	clear_agent_worktrees: (_command, ctx) => clearAgentWorktrees(ctx.omp, ctx.cwd),
};
