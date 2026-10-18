/**
 * How this machine spawns a local omp sidecar. The pool's local tabs and the
 * remote host's tabs for paired devices (src/main/remote/host-services.ts)
 * both come from here, so a session runs the same way whoever opened it.
 */
import { join } from "node:path";
import { app } from "electron";
import type { AutoTitleSettings } from "../../resources/gui-bridge/modes/auto-title-contracts";
import { AUTOPILOT_FRAME_TYPES } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { isDelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { normalizeUserProfile } from "../../resources/gui-bridge/modes/user-profile-contracts";
import type { PromptOriginEnv } from "../../resources/gui-bridge/prompt-origin-contracts";
import { parseAccountRotationPref } from "../shared/account-rotation";
import { agentControlEnabled } from "../shared/agent-control";
import { reaExtensionArgs } from "../shared/builtin-mcp";
import { deviceLanguageTag, replyLanguageName, resolveReplyLanguage } from "../shared/reply-language";
import { bootModelSelector } from "./boot-model";
import type { BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { builtinReaState } from "./builtin-mcp";
import { ompFailureText } from "./i18n";
import { ompAvailability } from "./omp-availability";
import { systemOmp } from "./omp-runtime";
import { writeRuntimeLog } from "./runtime-log";
import type { SessionKindStore } from "./session-kinds";
import { shellSpawnEnv } from "./shell-env";
import { SidecarManager } from "./sidecar";
import { markStartup } from "./startup-timing";

export interface LocalSidecarDeps {
	/** The gui-bridge extension directory. */
	bridgeDir: string;
	/** OMPdesk's own extension root (`resources/omp-builtin`): the control tools' skill; REA is its `rea/` sub-root. */
	builtinDir: string;
	builtinReaPref: () => unknown;
	/** Settings › Tools & extensions › OMPdesk control tools (`agentControl`, default on), read per use; absent = off (the caller that answers the tools supplies it). */
	agentControlPref?: () => unknown;
	/** A tab's session became ready (every time; the caller keeps what it needs). */
	onReady?: () => void;
	/** Proxy env per spawn (GUI pref → inherited env → system proxy). */
	proxyEnv: () => Promise<Record<string, string>>;
	bridgeHealth: BridgeHealth;
	sessionKinds: SessionKindStore;
	/** The stored Settings › General conversation-language pref (`replyLanguage`), read per use. */
	replyLanguagePref: () => unknown;
	/** The stored Settings › General profile pref (`userProfile`), read per use. */
	userProfilePref: () => unknown;
	/** The prompt-suggestion switches (`nextPromptSuggestions`, `nextPromptInline`; both default on), read per use. */
	nextPromptPrefs: () => NextPromptSettings;
	/** The automatic-title switches (`autoTitle`, `autoTitleEvolve`; both default on), read per use. */
	autoTitlePrefs: () => AutoTitleSettings;
	/** The composer delegation chip's last choice (`delegationMode`), read per spawn. */
	delegationPref: () => unknown;
	/** The stored Settings › Models & providers account-rotation pref (`accountRotation`), read per use. */
	accountRotationPref: () => unknown;
	/** The even-rotation ledger file every omp on this machine shares. */
	accountRotationLedger: string;
	/** The stored per-workspace launch profiles (`launchProfiles`), read per spawn. */
	launchProfilesPref: () => unknown;
	/** `-e` args for ai-memory's extension, read per spawn (see SidecarOptions.aiMemoryExtensionArgs). */
	aiMemoryExtensionArgs?: () => string[];
	/**
	 * Autopilot's coordinator (src/main/autopilot.ts), read per frame: it does not exist yet when the factory is
	 * made. Absent or null: autopilot frames pass through untouched.
	 */
	autopilot?: () => AutopilotFrameSink | null;
	/**
	 * The desktop slot (src/main/desktop-slot-host.ts), read per frame: it is built with the IPC handlers, after the
	 * factory. Absent or null: the bridge's slot frames go unanswered.
	 */
	desktopSlot?: () => DesktopSlotFrameSink | null;
}

/** The device language as a BCP 47 subtag (`ko`, `zh-Hant`): not the UI one, which ships only en/ko. */
export function deviceLanguage(): string | undefined {
	return deviceLanguageTag(app.getPreferredSystemLanguages(), app.getLocale());
}

/** `origin`: the paired device a host tab serves (absent for this machine's own tabs). */
export type LocalSidecarFactory = (
	cwd: string,
	kind: "agent" | "chat",
	fresh: boolean,
	origin?: PromptOriginEnv,
) => SidecarManager;

/** What the factory hands the coordinator: the status to overlay, and the bridge's autopilot frames. */
export interface AutopilotFrameSink {
	overlay(sidecar: SidecarManager, frame: Record<string, unknown>): Record<string, unknown>;
	frame(sidecar: SidecarManager, frame: Record<string, unknown>): void;
}

/** What the factory hands the desktop slot: the bridge's `desktop_slot_*` frames of one omp process. */
export interface DesktopSlotFrameSink {
	frame(sidecar: SidecarManager, frame: Record<string, unknown>): void;
}

export function localSidecarFactory(deps: LocalSidecarDeps): LocalSidecarFactory {
	const { bridgeDir, bridgeHealth, sessionKinds } = deps;
	return (cwd, kind, fresh, origin) => {
		const sc: SidecarManager = new SidecarManager({
			// The status keeps this reason (Settings, the status snapshot); localize it in the UI language.
			// While machine setup has omp missing or installing, a half-installed omp is not even resolved.
			omp: async () => {
				if (ompAvailability() === "missing") return { ok: false, error: ompFailureText({ kind: "not-found" }) };
				const resolution = await systemOmp();
				markStartup("omp-resolved", { ok: resolution.ok });
				return resolution.ok || !resolution.reason
					? resolution
					: { ...resolution, error: ompFailureText(resolution.reason) };
			},
			bridgeDir,
			builtinMcp: async () => {
				const reaRoot = join(deps.builtinDir, "rea");
				const rea = reaExtensionArgs(reaRoot, await builtinReaState(deps.builtinReaPref()));
				// The control tools' skill loads with them; the tools themselves follow the switch live (hostTools).
				const own =
					deps.agentControlPref && agentControlEnabled(deps.agentControlPref()) ? ["-e", deps.builtinDir] : [];
				return { args: [...own, ...rea], ...(rea.length ? { root: reaRoot } : {}) };
			},
			hostTools: () => deps.agentControlPref !== undefined && agentControlEnabled(deps.agentControlPref()),
			cwd,
			kind,
			fresh,
			promptOrigin: origin,
			proxyEnv: deps.proxyEnv,
			shellEnv: shellSpawnEnv,
			replyLanguage: () => resolveReplyLanguage(deps.replyLanguagePref(), replyLanguageName(deviceLanguage())),
			userProfile: () => normalizeUserProfile(deps.userProfilePref()),
			nextPrompt: deps.nextPromptPrefs,
			autoTitle: deps.autoTitlePrefs,
			delegation: () => {
				const stored = deps.delegationPref();
				return isDelegationMode(stored) ? stored : "default";
			},
			accountRotation: () => parseAccountRotationPref(deps.accountRotationPref()),
			accountRotationLedger: deps.accountRotationLedger,
			launchProfiles: deps.launchProfilesPref,
			...(deps.aiMemoryExtensionArgs ? { aiMemoryExtensionArgs: deps.aiMemoryExtensionArgs } : {}),
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
			// The coordinator adds what only main knows (children, ship queue) before a window sees the status.
			frameTransform: (frame): Record<string, unknown> =>
				frame.type === "autopilot_update" ? (deps.autopilot?.()?.overlay(sc, frame) ?? frame) : frame,
		});
		// Ready-health-check applies to every sidecar, not just the first.
		// A failure marks the live child `error` without killing it; the manager
		// re-probes and returns it to `ready` once a command succeeds again.
		sc.on("status", ({ status }) => {
			if (status !== "ready") return;
			markStartup("sidecar-ready");
			deps.onReady?.();
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
		sc.on("bridge", (result: BridgeConnectResult) => {
			markStartup("bridge-connected");
			void bridgeHealth.observe(result);
		});
		// The bridge's goal time limit ran out (resources/gui-bridge/modes/goal.ts): pause through stock RPC `goal`
		// `pause`, the path that also gives back the pre-goal tool set and resets continuation (RpcGoalController
		// `#exit`); the bridge has no handle on that controller. A failed pause leaves the goal running and the
		// bridge reports the limit again.
		sc.on("frame", (frame: { type?: unknown }) => {
			if (frame.type !== "goal_time_limit_reached") return;
			void sc.rpcClient
				?.command({ type: "set_goal", action: "pause" })
				.then(response => {
					if (!response.success) throw new Error(response.error ?? "goal pause failed");
				})
				.catch((error: unknown) =>
					writeRuntimeLog(
						{ source: "goal-time-limit", message: error instanceof Error ? error.message : String(error) },
						{ cwd },
					),
				);
		});
		// The bridge's autopilot frames (cycle end, stop request, settled) are the coordinator's to act on.
		sc.on("frame", (frame: Record<string, unknown>) => {
			if (typeof frame.type === "string" && (AUTOPILOT_FRAME_TYPES as readonly string[]).includes(frame.type)) {
				deps.autopilot?.()?.frame(sc, frame);
			}
		});
		// The bridge's desktop slot frames (acquire, touch, release) are the slot's to act on; they reach no window.
		sc.on("frame", (frame: Record<string, unknown>) => {
			if (typeof frame.type === "string" && frame.type.startsWith("desktop_slot_")) {
				deps.desktopSlot?.()?.frame(sc, frame);
			}
		});
		// omp has no session kind; remember which sessions chat tabs created.
		if (kind === "chat") sc.on("session", ({ sessionId }) => sessionId && sessionKinds.markChat(sessionId));
		return sc;
	};
}
