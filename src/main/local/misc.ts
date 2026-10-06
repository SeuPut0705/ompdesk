/**
 * Voice, debug console, security dashboard, SSH hosts and omp updates.
 *
 * Session-bound commands go to the gui-bridge `misc` methods. Updates drive the
 * system omp CLI directly: `omp update --check` reports the installed and
 * latest versions (honoring the user's channel and npm registry), and
 * `omp_update` runs `omp update` itself.
 */
import { parseOmpVersion } from "../omp-runtime";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

const UPDATE_CHECK_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
/** Plain text from omp's chalk output, so the update report parses the same everywhere. */
const PLAIN_ENV = { NO_COLOR: "1", FORCE_COLOR: "0" };

export interface OmpUpdateCheck {
	currentVersion: string;
	latestVersion: string;
}

/** Parse `omp update --check`: `Current version: X`, then `New version available: Y` or `Already up to date`. */
export function parseUpdateCheck(output: string): OmpUpdateCheck | null {
	const current = /Current version:\s*(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
	if (!current) return null;
	const latest =
		/New version available:\s*(\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ??
		(/Already up to date/.test(output) ? current : undefined);
	return latest ? { currentVersion: current, latestVersion: latest } : null;
}

function lastLines(text: string, count = 6): string {
	return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

async function checkOmpUpdate(ctx: LocalCommandContext) {
	const result = await ctx.omp.run(["update", "--check"], {
		cwd: ctx.cwd,
		timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
		env: PLAIN_ENV,
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

async function runOmpUpdate(ctx: LocalCommandContext) {
	const result = await ctx.omp.run(["update"], { cwd: ctx.cwd, timeoutMs: UPDATE_TIMEOUT_MS, env: PLAIN_ENV });
	if (result.code !== 0) {
		throw new LocalCommandError(
			lastLines(result.stderr || result.stdout) || `omp update exited with code ${result.code}`,
			"update_failed",
		);
	}
	const version = await ctx.omp.run(["--version"], { cwd: ctx.cwd, env: PLAIN_ENV });
	return { version: parseOmpVersion(version.stdout) ?? ctx.omp.version, output: lastLines(result.stdout, 12) };
}

/** Forward to a gui-bridge method with the command's own fields as params. */
function viaBridge(method: string): LocalHandler {
	return ({ type: _type, id: _id, ...params }, ctx) => ctx.bridge.request(method, params);
}

export const handlers: Record<string, LocalHandler> = {
	transcribe_audio: viaBridge("transcribe_audio"),
	synthesize_speech: viaBridge("synthesize_speech"),
	debug: viaBridge("debug"),
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
	omp_update: (_command, ctx) => runOmpUpdate(ctx),
};
