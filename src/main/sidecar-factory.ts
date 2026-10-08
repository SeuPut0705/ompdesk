/**
 * How this machine spawns a local omp sidecar. The pool's local tabs and the
 * remote host's tabs for paired devices (src/main/remote/host-services.ts)
 * both come from here, so a session runs the same way whoever opened it.
 */
import { app } from "electron";
import { parseAccountRotationPref } from "../shared/account-rotation";
import { deviceLanguageTag, replyLanguageName, resolveReplyLanguage } from "../shared/reply-language";
import { bootModelSelector } from "./boot-model";
import type { BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { ompFailureText } from "./i18n";
import { systemOmp } from "./omp-runtime";
import { writeRuntimeLog } from "./runtime-log";
import type { SessionKindStore } from "./session-kinds";
import { shellSpawnEnv } from "./shell-env";
import { SidecarManager } from "./sidecar";

export interface LocalSidecarDeps {
	/** The gui-bridge extension directory. */
	bridgeDir: string;
	/** Proxy env per spawn (GUI pref → inherited env → system proxy). */
	proxyEnv: () => Promise<Record<string, string>>;
	bridgeHealth: BridgeHealth;
	sessionKinds: SessionKindStore;
	/** The stored Settings › General conversation-language pref (`replyLanguage`), read per use. */
	replyLanguagePref: () => unknown;
	/** The stored Settings › Models & providers account-rotation pref (`accountRotation`), read per use. */
	accountRotationPref: () => unknown;
	/** The even-rotation ledger file every omp on this machine shares. */
	accountRotationLedger: string;
}

/** The device language as a BCP 47 subtag (`ko`, `zh-Hant`): not the UI one, which ships only en/ko. */
export function deviceLanguage(): string | undefined {
	return deviceLanguageTag(app.getPreferredSystemLanguages(), app.getLocale());
}

export type LocalSidecarFactory = (cwd: string, kind: "agent" | "chat", fresh: boolean) => SidecarManager;

export function localSidecarFactory(deps: LocalSidecarDeps): LocalSidecarFactory {
	const { bridgeDir, bridgeHealth, sessionKinds } = deps;
	return (cwd, kind, fresh) => {
		const sc = new SidecarManager({
			// The status banner shows this text; localize it in the UI language.
			omp: async () => {
				const resolution = await systemOmp();
				return resolution.ok || !resolution.reason
					? resolution
					: { ...resolution, error: ompFailureText(resolution.reason) };
			},
			bridgeDir,
			cwd,
			kind,
			fresh,
			proxyEnv: deps.proxyEnv,
			shellEnv: shellSpawnEnv,
			replyLanguage: () => resolveReplyLanguage(deps.replyLanguagePref(), replyLanguageName(deviceLanguage())),
			accountRotation: () => parseAccountRotationPref(deps.accountRotationPref()),
			accountRotationLedger: deps.accountRotationLedger,
			bootModel: runtime => bootModelSelector(runtime, bridgeDir),
			// Finder-launched omp has no terminal, and a sidecar that dies before
			// it can write its own log only speaks through stderr — land the tail
			// in gui-runtime.jsonl so it is readable after the fact.
			reportFailure: report => {
				writeRuntimeLog(
					{
						source: "sidecar-restart",
						message: report.reason,
						details: { attempt: report.attempt, maxAttempts: report.maxAttempts, stderr: report.stderr },
					},
					{ cwd: report.cwd },
				);
			},
		});
		// Ready-health-check applies to every sidecar, not just the first.
		// A failure marks the live child `error` without killing it; the manager
		// re-probes and returns it to `ready` once a command succeeds again.
		sc.on("status", ({ status }) => {
			if (status !== "ready") return;
			const client = sc.rpcClient;
			if (!client) return;
			client
				.command({ type: "get_state" })
				.then(res => {
					if (!res.success) sc.markUnhealthy(`Health check failed: ${res.error ?? "unknown"}`);
				})
				.catch(err => {
					sc.markUnhealthy(`Health check timed out: ${err instanceof Error ? err.message : String(err)}`);
				});
		});
		sc.on("bridge", (result: BridgeConnectResult) => void bridgeHealth.observe(result));
		// omp has no session kind; remember which sessions chat tabs created.
		if (kind === "chat") sc.on("session", ({ sessionId }) => sessionId && sessionKinds.markChat(sessionId));
		return sc;
	};
}
