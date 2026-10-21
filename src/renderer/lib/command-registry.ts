import {
	activeTabCommand,
	focusedSessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	withSessionRuntime,
} from "../stores/session-runtime-context";
import { createTabRpc, type TabRpc } from "./tab-rpc";

/**
 * Declarative command registry: maps every known slash command to a typed
 * UI affordance so the GUI can present them as first-class menu actions
 * instead of injecting "/command" text into the composer.
 *
 * Affordance kinds:
 * - `action`      — fire an RPC command or store action immediately
 * - `toggle`      — boolean state toggle with live on/off status
 * - `picker`      — open a picker dialog (model, thinking level)
 * - `window`      — open a dedicated window (usage, providers, settings)
 * - `submenu`     — expand into subcommands (mcp, marketplace, security…)
 * - `prompt`      — send the command text as a prompt (text-mode fallback)
 * - `unavailable` — non-text command lacking a native GUI affordance
 */

import { OUTPUT_STYLE_IDS } from "../../../resources/gui-bridge/modes/output-style-contracts";
import type { AvailableCommand, CopyTarget, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession, hydrateTabSession } from "../hooks/use-rpc-events";
import { newSessionNow } from "../hooks/use-session-switch";
import { openHandoffDialog } from "../stores/fork-handoff";
import { useModelStore } from "../stores/model";
import { useOutputStyleStore } from "../stores/output-style";
import { type SessionStore, useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { type AgentsTab, type DockCardId, type InsightsStatsScope, type InsightsTab, useUiStore } from "../stores/ui";
import { checkForUpdatesInPlace } from "../stores/updater";
import type { CommandGuard } from "./command-search";
import { requestComposerAction } from "./composer-actions";
import { readDisplayPreference, setDisplayPreference } from "./display-preferences";
import { exportSessionHtml } from "./export-session";
import { copyText } from "./format";
import { translate } from "./i18n";
import { actionKbd, type KeymapActionId, type KeymapOverrides } from "./keymap";
import {
	abortActiveTurn,
	clearSessionContext,
	restoreQueuedMessages,
	retryLastTurn as retryLastTurnShared,
	runManualMaintenance,
} from "./messages";
import {
	capturePluginActivationOrigin,
	handlePluginActivation,
	isPluginActivationOriginActive,
} from "./plugin-activation";
import { runInTerminal } from "./run-in-terminal";
import { closeActiveTab, closeOtherTabs } from "./tab-close";
import { copyTodosToClipboard, dumpTranscriptToClipboard, exportTodos, importTodosFromFile } from "./transcript-copy";
import { focusWorkBoard } from "./work-board-focus";
import {
	addWorkspaceDirectory,
	moveSessionTo,
	pickFocusedTabDirectory,
	selectFocusedTabProject,
} from "./workspace-dirs";

/**
 * `action` and `prompt` carry `argUsage` when the command needs user text
 * before it can run: the palette has no argument entry, so those rows hand the
 * command back to the composer instead of dispatching it argument-less.
 */
export type CommandAffordance =
	| { kind: "action"; run: (args?: string) => unknown; status?: string; argUsage?: string }
	| { kind: "toggle"; get: () => boolean; set: (enabled: boolean) => unknown }
	| { kind: "picker"; open: () => void }
	| { kind: "window"; open: () => void }
	| { kind: "submenu"; items: CommandMenuItem[] }
	| { kind: "prompt"; text: string; argUsage?: string }
	| { kind: "unavailable"; reason: string };

export interface CommandMenuItem {
	name: string;
	label: string;
	description?: string;
	category: CommandCategory;
	affordance: CommandAffordance;
	shortcut?: string;
	aliases?: string[];
	/**
	 * Starts a turn or destroys state. The palette never runs it from Enter on
	 * a partial match (see `commandGuard` / `enterNeedsConfirm`).
	 */
	guard?: CommandGuard;
	/**
	 * A typed `/mcp <verb>` runs its `action`/`window` affordance (composer-submit); this one is still sent as text
	 * because stock's own reply (a listing in the transcript) is what the person typed it for.
	 */
	typedAsPrompt?: boolean;
}

/** Palette sections, in display order (design spec §2 IA). */
export const COMMAND_CATEGORIES = [
	"session",
	"agents",
	"insights",
	"model",
	"providers",
	"context",
	"modes",
	"tools",
	"panel",
	"workspace",
	"extensions",
	"settings",
	"help",
	"other",
] as const;

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/**
 * Effective Enter guard: the item's own, else a dispatched prompt (no
 * argument to fill in) is turn-starting — it sends text to the agent.
 */
export function commandGuard(item: CommandMenuItem): CommandGuard | undefined {
	if (item.guard) return item.guard;
	return item.affordance.kind === "prompt" && !item.affordance.argUsage ? "turn" : undefined;
}

export interface CommandRegistryContext {
	/**
	 * Translator for built-in labels/descriptions. Components pass their
	 * reactive `useT()` so the memoized menu rebuilds on locale switch;
	 * non-component callers pass the module-scope `translate()`.
	 */
	t: (key: string, params?: Record<string, string | number>) => string;
	isStreaming: boolean;
	fastModeEnabled: boolean;
	autoCompaction: boolean;
	autoRetry: boolean;
	planModeEnabled: boolean;
	prewalkArmed: boolean;
	availableCommands: AvailableCommand[];
	/** The user's remapped chords; rows backed by a shortcut show the chord that fires it. */
	keymapOverrides?: KeymapOverrides;
	openModelPicker: () => void;
	openSettings: (tab?: string) => void;
	openProviders: () => void;
	openFeedback: () => void;
	openRenameDialog: () => void;
	openSessionPicker: () => void;
	openBranchPicker: () => void;
	openSessionTree: () => void;
	openBenchmark: () => void;
	openHandoffDialog: () => void;
	openThemePicker: () => void;
	openModes: (tab?: "plan" | "goal" | "autopilot") => void;
	/** Agents page (Live · Definitions · Pull requests). */
	openAgents: (tab?: AgentsTab) => void;
	/** Insights page (Stats with a This session / All sessions scope · Usage). */
	openInsights: (tab?: InsightsTab, scope?: InsightsStatsScope) => void;
	openImportDialog: () => void;
	openProviderConfig: () => void;
	/** Deep-link a center-dock card (todo/plan): expand + flash. */
	focusDockCard: (id: DockCardId) => void;
	/** Retry the last failed turn server-side (retry RPC). */
	retryTurn: () => Promise<unknown>;
	/** Re-send the most recent user message (abortAndPrompt while streaming). */
	retryLastTurn: () => Promise<unknown>;
	/** Clone the whole session at head (true /fork) into a new session. */
	forkSession: () => Promise<unknown>;
	/** Refresh session state after a mutation (compact, fork, etc). */
	hydrateSession: () => Promise<void>;
	rpc: {
		setFastMode: (enabled: boolean) => Promise<RpcResponse>;
		setAutoCompaction: (enabled: boolean) => Promise<RpcResponse>;
		setAutoRetry: (enabled: boolean) => Promise<RpcResponse>;
		compact: (instructions?: string) => Promise<RpcResponse>;
		newSession: () => Promise<unknown>;
		setPlanMode: (enabled: boolean) => Promise<RpcResponse>;
		setPrewalk: (enabled: boolean) => Promise<RpcResponse>;
		cycleModel: () => Promise<unknown>;
		cycleThinkingLevel: () => Promise<unknown>;
	};
}

/**
 * Commands left as kind:"prompt" forward `/cmd` text to the agent, which
 * runs the logic agent-side and replies with TUI-rendered text. Nativizing
 * them needs a dedicated RPC per command (structured result instead of text)
 * — tracked as P1: security, session delete, session pin.
 */

/** Helper to build a prompt affordance. */
const p = (text: string, argUsage?: string): CommandAffordance => ({ kind: "prompt", text, argUsage });

/**
 * Locale key stem for a command name: hyphens camelCase, spaces become dots
 * ("model cycle" → "cmd.model.cycle", "mcp smithery-search" → "cmd.mcp.smitherySearch").
 */
const keyOf = (name: string): string =>
	name.replace(/-(\w)/g, (_hyphen, ch: string) => ch.toUpperCase()).replace(/ /g, ".");

/**
 * Runtime toggle applier (mirrors SettingsWindow's apply* pattern): toast on
 * RPC failure, otherwise apply the returned state to the owning store so the
 * UI reflects the server truth immediately instead of waiting for a push.
 */
export async function runSessionCommand(
	promise: Promise<RpcResponse>,
	title: string,
	apply?: (data: unknown) => void,
): Promise<void> {
	const runtime = focusedSessionRuntime();
	const sessionId = useSessionStore.getState().sessionId;
	try {
		const res = await promise;
		if (!res.success) {
			toastError({ title, error: res });
			return;
		}
		if (!apply) return;
		if (runtime) {
			if (
				sessionRuntime(runtime.tabId) !== runtime ||
				sessionRuntimeStore<SessionStore>(runtime.tabId, "session")?.getState().sessionId !== sessionId
			)
				return;
			withSessionRuntime(runtime.tabId, () => apply(res.data));
		} else if (useSessionStore.getState().sessionId === sessionId) apply(res.data);
	} catch (cause) {
		toastError({ title, error: cause });
	}
}

/** Restart the focused tab's sidecar without interrupting an active turn. */
export async function restartSidecarFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const session = runtime
		? sessionRuntimeStore<SessionStore>(runtime.tabId, "session")?.getState()
		: useSessionStore.getState();
	if (session?.isStreaming || session?.isCompacting) {
		toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
		return;
	}
	try {
		await window.omp.sidecar.restart({ tabId: runtime?.tabId, sessionPath: session?.sessionFile ?? undefined });
		toast({ variant: "info", message: translate("settings.launch.restarting") });
	} catch (cause) {
		toastError({ title: translate("app.actionFailed"), error: cause });
	}
}

export function buildCommandMenu(ctx: CommandRegistryContext): CommandMenuItem[] {
	const { t } = ctx;
	const runtime = focusedSessionRuntime();
	const boundRpc = runtime
		? createTabRpc(runtime.command)
		: typeof window === "undefined"
			? createTabRpc(activeTabCommand)
			: window.omp.rpc;
	const items: CommandMenuItem[] = [];
	/** Every name the menu claims: item names plus their aliases. */
	const claimed = new Set<string>();

	/** Single insertion point: the first claimant of a name (or alias) wins. */
	const add = (item: CommandMenuItem) => {
		if (claimed.has(item.name)) return;
		claimed.add(item.name);
		for (const alias of item.aliases ?? []) claimed.add(alias);
		items.push(item);
	};
	/** The chord that fires a remappable action now (the user's remap first); none when unbound. */
	const kbd = (id: KeymapActionId) => actionKbd(id, ctx.keymapOverrides) || undefined;

	/** Helper to build a submenu item; the label resolves through the ctx translator. */
	const sub = (name: string, text: string, argUsage?: string): CommandMenuItem => ({
		name,
		label: t(`cmd.${keyOf(name)}`),
		category: "extensions",
		affordance: p(text, argUsage),
	});

	/** Helper to build a submenu item executing a native action (RPC/store) instead of prompt text. */
	const subAction = (name: string, run: (args?: string) => unknown): CommandMenuItem => ({
		name,
		label: t(`cmd.${keyOf(name)}`),
		category: "extensions",
		affordance: { kind: "action", run },
	});

	/** Helper to build a submenu item opening a native surface (panel/tab/dialog). */
	const subWindow = (name: string, open: () => void): CommandMenuItem => ({
		name,
		label: t(`cmd.${keyOf(name)}`),
		category: "extensions",
		affordance: { kind: "window", open },
	});

	/** Read a single setting for status toasts; RPC failures throw for the palette to surface. */
	const readSetting = async (path: string): Promise<unknown> => {
		const res = await boundRpc.getSettings([path]);
		if (!res.success) throw new Error(res.error);
		return (res.data as { values?: Record<string, unknown> } | undefined)?.values?.[path];
	};

	/**
	 * Persist a settings mutation via the same set_setting RPC the SettingsWindow
	 * toggles use (the agent live-applies runtime keys) and toast the result.
	 */
	const writeSetting = async (path: string, value: unknown, message: string): Promise<void> => {
		const res = await boundRpc.setSetting(path, value);
		if (!res.success) throw new Error(res.error);
		toast({ variant: "success", message });
	};

	const restartSidecar = restartSidecarFromGui;

	/** /advisor on|off — set_setting live-applies advisor.enabled and reports activation state. */
	const setAdvisor = async (enabled: boolean): Promise<void> => {
		const res = await boundRpc.setSetting("advisor.enabled", enabled);
		if (!res.success) throw new Error(res.error);
		const data = res.data as { advisorEnabled?: boolean; advisorActive?: boolean } | undefined;
		if (enabled && data?.advisorEnabled === true && data.advisorActive !== true) {
			toast({
				variant: "info",
				message: t("advisor.noModel"),
				action: { label: t("modelSetup.open"), run: () => useUiStore.getState().openModelSetup() },
				durationMs: 10_000,
			});
			return;
		}
		toast({ variant: "success", message: t(enabled ? "advisor.enabled" : "advisor.disabled") });
	};

	/**
	 * /autoclear on [delay] | off — stock's idle compaction (`compaction.idle*`),
	 * which the bridge's idle-compaction timer runs for GUI tabs. A delay like
	 * `10m`, `90s`, `1h` or bare seconds sets `compaction.idleTimeoutSeconds`
	 * (stock clamps it to 60–3600 s when it arms).
	 */
	const setIdleCompaction = async (enabled: boolean, args?: string): Promise<void> => {
		const delay = args?.trim();
		if (enabled && delay) {
			const match = /^(\d+)\s*(s|m|h)?$/i.exec(delay);
			if (!match) {
				toast({ variant: "warning", message: t("cmd.autoclear.badDelay", { value: delay }) });
				return;
			}
			const unit = match[2]?.toLowerCase();
			const seconds = Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
			const clamped = Math.max(60, Math.min(3600, seconds));
			const res = await boundRpc.setSetting("compaction.idleTimeoutSeconds", clamped);
			if (!res.success) throw new Error(res.error);
		}
		const res = await boundRpc.setSetting("compaction.idleEnabled", enabled);
		if (!res.success) throw new Error(res.error);
		if (!enabled) {
			toast({ variant: "success", message: t("cmd.autoclear.disabled") });
			return;
		}
		const seconds = Number(await readSetting("compaction.idleTimeoutSeconds"));
		const minutes = Math.round(Math.max(60, Math.min(3600, Number.isFinite(seconds) ? seconds : 300)) / 60);
		toast({ variant: "success", message: t("cmd.autoclear.enabled", { minutes }) });
	};

	/** /mcp enable|disable|remove|reconnect <name>; a bare invocation opens the native MCP tab. */
	const runMcpAction = async (verb: "enable" | "disable" | "reconnect" | "remove", args?: string): Promise<void> => {
		const name = args?.trim();
		if (!name) {
			ctx.openSettings("tools:mcp");
			return;
		}
		const res = await boundRpc.mcpAction(name, verb);
		if (!res.success) throw new Error(res.error);
		await ctx.hydrateSession();
		toast({ variant: "success", message: t(`mcpAction.${verb}`, { name }) });
	};

	/** /mcp reauth <name> signs in through the bridge (stock's headless /mcp cannot); a bare invocation opens the native MCP tab. */
	const runMcpReauth = async (args?: string): Promise<void> => {
		const name = args?.trim();
		if (!name) {
			ctx.openSettings("tools:mcp");
			return;
		}
		const res = await boundRpc.mcpReauth(name);
		if (!res.success) {
			if (res.code === "oauth_busy") toast({ variant: "info", message: t("mcp.reauth.busy") });
			else toastError({ title: t("mcp.reauth.failed"), error: res });
			return;
		}
		const data = res.data as { ok?: boolean; error?: string } | undefined;
		if (data?.ok === false) {
			if (data.error === "cancelled") toast({ variant: "info", message: t("mcp.reauth.cancelled") });
			else toastError({ title: t("mcp.reauth.failed"), error: data });
			return;
		}
		await ctx.hydrateSession();
		toast({ variant: "success", message: t("mcp.reauth.ok", { name }) });
	};

	/** /mcp reload rediscovers and reconnects every MCP server of this session and every live tab (stock's headless one only refreshes commands). */
	const runMcpReload = async (): Promise<void> => {
		const res = await boundRpc.mcpReload();
		if (!res.success) throw new Error(res.error);
		await ctx.hydrateSession();
		toast({ variant: "success", message: t("mcpAction.reload") });
	};

	/**
	 * /marketplace mutations via marketplace_action. Install intentionally opens
	 * Inventory so the trust confirmation is the only executable-code entry.
	 */
	const runMarketplaceAction = async (
		verb: "add" | "remove" | "update" | "uninstall" | "upgrade",
		args?: string,
	): Promise<void> => {
		const input = args?.trim() ?? "";
		if (!input && verb !== "update") {
			ctx.openSettings(verb === "uninstall" ? "tools:plugins" : "tools:marketplaces");
			return;
		}
		const origin = verb === "uninstall" || verb === "upgrade" ? capturePluginActivationOrigin() : null;
		if ((verb === "uninstall" || verb === "upgrade") && !origin) {
			throw new Error(t("pluginActivation.routePending"));
		}
		const payload: { action: typeof verb; marketplace?: string; plugin?: string; source?: string } = {
			action: verb,
		};
		if (verb === "add") payload.source = input;
		else if (verb === "remove" || verb === "update") {
			if (input) payload.marketplace = input;
		} else {
			// uninstall/upgrade address plugins as name@marketplace (TUI arg form).
			const at = input.lastIndexOf("@");
			if (at <= 0 || at === input.length - 1) throw new Error(t("marketplaceAction.badId", { id: input }));
			payload.plugin = input.slice(0, at);
			payload.marketplace = input.slice(at + 1);
		}
		const res = await boundRpc.marketplaceAction(payload);
		if (!res.success) throw new Error(res.error);
		const data = res.data as { ok?: boolean; error?: string; activation?: string } | undefined;
		if (data?.ok === false) throw new Error(data.error ?? t("marketplaceAction.failed"));
		if (origin) {
			await handlePluginActivation(
				data?.activation,
				{ pluginId: input, expected: verb === "uninstall" ? "disabled" : "enabled" },
				origin,
			);
			if (!isPluginActivationOriginActive(origin)) return;
		}
		await ctx.hydrateSession();
		toast({ variant: "success", message: t(`marketplaceAction.${verb}`, { name: input }) });
	};

	/** /plugins enable|disable <name@marketplace>; a bare invocation opens the installed-plugins tab. */
	const runPluginEnabled = async (enabled: boolean, args?: string): Promise<void> => {
		const id = args?.trim();
		if (!id) {
			ctx.openSettings("tools:plugins");
			return;
		}
		const origin = capturePluginActivationOrigin();
		if (!origin) throw new Error(t("pluginActivation.routePending"));
		const res = await boundRpc.setPluginEnabled(id, enabled);
		if (!res.success) throw new Error(res.error);
		const data = res.data as { activation?: string } | undefined;
		await handlePluginActivation(
			data?.activation,
			{ pluginId: id, expected: enabled ? "enabled" : "disabled" },
			origin,
		);
		if (isPluginActivationOriginActive(origin)) {
			await ctx.hydrateSession();
			toast({
				variant: "success",
				message: t(enabled ? "pluginAction.enabled" : "pluginAction.disabled", { name: id }),
			});
		}
	};

	// ═══════════════════════════════════════════════════════════════════
	// SESSION
	// ═══════════════════════════════════════════════════════════════════
	// /new and /clear replace the session server-side and would silently abort
	// an in-flight run — block while busy, same guard as the menu/deep-link
	// paths and the WorkspaceDialog actions.
	const newSessionGuarded = (): Promise<unknown> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return ctx.rpc.newSession();
	};
	// /clear drops context in place (clear_context RPC) — the server refuses
	// while streaming; guard client-side with the same busy toast.
	const clearContextGuarded = (): Promise<boolean> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return clearSessionContext();
	};
	// /fresh rotates provider stream state (fresh RPC) — same busy boundary as
	// /clear, so it gets the same client-side guard.
	const freshGuarded = (): Promise<void> | undefined => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return undefined;
		}
		return freshProviderStateFromGui();
	};
	add({
		name: "new",
		label: t("cmd.new"),
		description: t("cmd.new.desc"),
		category: "session",
		shortcut: "⌘N",
		affordance: { kind: "action", run: () => newSessionGuarded() },
		// Replacing the session mid-run would abort it; idle it's harmless.
		guard: ctx.isStreaming ? "destructive" : undefined,
	});
	add({
		name: "new-tab",
		label: t("cmd.newTab"),
		description: t("cmd.newTab.desc"),
		category: "session",
		shortcut: kbd("tab.new"),
		affordance: { kind: "action", run: () => useTabsStore.getState().openTab() },
	});
	add({
		name: "new-chat-tab",
		label: t("cmd.newChatTab"),
		description: t("cmd.newChatTab.desc"),
		category: "session",
		shortcut: kbd("tab.newChat"),
		affordance: { kind: "action", run: () => useTabsStore.getState().openTab({ kind: "chat" }) },
	});
	add({
		name: "new-worktree-tab",
		label: t("hotkeys.row.tabNewWorktree"),
		category: "session",
		shortcut: kbd("tab.newWorktree"),
		affordance: { kind: "window", open: () => useUiStore.getState().openWorktreeDialog() },
	});
	add({
		name: "close-tab",
		label: t("hotkeys.row.tabClose"),
		category: "session",
		shortcut: kbd("tab.close"),
		// A live run arms the tab chip's inline confirm instead of closing.
		affordance: { kind: "action", run: () => closeActiveTab() },
	});
	add({
		name: "reopen-tab",
		label: t("hotkeys.row.tabReopen"),
		category: "session",
		shortcut: kbd("tab.reopen"),
		affordance: { kind: "action", run: () => useTabsStore.getState().reopenClosedTab() },
	});
	add({
		name: "quick-open",
		label: t("quickOpen.title"),
		description: t("quickOpen.placeholder"),
		category: "session",
		shortcut: kbd("quickOpen"),
		affordance: { kind: "picker", open: () => useUiStore.getState().openQuickOpen() },
	});
	add({
		name: "search-files",
		label: t("filesPanel.contentSearch.toggle"),
		description: t("filesPanel.contentSearch.hint"),
		category: "session",
		shortcut: kbd("files.search"),
		affordance: { kind: "action", run: () => useUiStore.getState().openFilesSearch() },
	});
	add({
		name: "close-other-tabs",
		label: t("tabs.menu.closeOthers"),
		category: "session",
		affordance: {
			kind: "action",
			run: async () => {
				const keep = useTabsStore.getState().activeTabId;
				if (!keep) return;
				const kept = await closeOtherTabs(keep);
				if (kept > 0) toast({ variant: "info", message: t("tabs.closeOthersKept", { count: kept }) });
			},
		},
	});
	add({
		name: "clear",
		label: t("cmd.clear"),
		description: t("cmd.clear.desc"),
		category: "session",
		affordance: { kind: "action", run: () => clearContextGuarded() },
		guard: "destructive",
	});
	add({
		name: "resume",
		label: t("cmd.resume"),
		description: t("cmd.resume.desc"),
		category: "session",
		shortcut: kbd("sessions.search"),
		affordance: { kind: "picker", open: ctx.openSessionPicker },
	});
	add({
		name: "import",
		label: t("cmd.import"),
		description: t("cmd.import.desc"),
		category: "session",
		affordance: { kind: "window", open: () => ctx.openImportDialog() },
	});
	add({
		name: "session",
		label: t("cmd.session"),
		description: t("cmd.session.desc"),
		category: "session",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "session info",
					label: t("cmd.session.info"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInsights("stats", "session") },
				},
				// /session delete + /session pin stay forwarded — need dedicated RPC (P1).
				{ ...sub("session delete", "/session delete"), guard: "destructive" },
				sub("session pin", "/session pin ", "[account]"),
			],
		},
	});
	add({
		name: "rename",
		label: t("cmd.rename"),
		description: t("cmd.rename.desc"),
		category: "session",
		affordance: { kind: "picker", open: ctx.openRenameDialog },
	});
	add({
		name: "handoff",
		label: t("cmd.handoff"),
		description: t("cmd.handoff.desc"),
		category: "session",
		affordance: { kind: "picker", open: ctx.openHandoffDialog },
	});
	add({
		name: "export",
		label: t("cmd.export"),
		description: t("cmd.export.desc"),
		category: "session",
		affordance: { kind: "action", run: () => exportSessionHtml() },
	});
	add({
		name: "share",
		label: t("cmd.share"),
		description: t("cmd.share.desc"),
		category: "session",
		affordance: { kind: "window", open: () => useUiStore.getState().openShareSession() },
	});
	add({
		name: "dump",
		label: t("cmd.dump"),
		description: t("cmd.dump.desc"),
		category: "session",
		affordance: { kind: "action", run: () => dumpTranscriptToClipboard() },
	});
	add({
		name: "branch",
		label: t("cmd.branch"),
		description: t("cmd.branch.desc"),
		category: "session",
		affordance: { kind: "picker", open: ctx.openBranchPicker },
	});
	add({
		name: "fork",
		label: t("cmd.fork"),
		description: t("cmd.fork.desc"),
		category: "session",
		affordance: { kind: "action", run: () => ctx.forkSession() },
	});
	add({
		name: "tree",
		label: t("cmd.tree"),
		description: t("cmd.tree.desc"),
		category: "session",
		affordance: { kind: "window", open: ctx.openSessionTree },
	});
	add({
		name: "delete",
		aliases: ["drop"],
		label: t("cmd.delete"),
		description: t("cmd.drop.desc"),
		category: "session",
		affordance: { kind: "action", run: deleteSessionFromGui },
		guard: "destructive",
	});
	add({
		name: "close",
		label: t("cmd.close"),
		description: t("cmd.close.desc"),
		category: "session",
		affordance: { kind: "action", run: () => window.close() },
		guard: "destructive",
	});
	add({
		name: "restart",
		label: t("cmd.restart"),
		description: t("cmd.restart.desc"),
		category: "other",
		affordance: { kind: "action", run: restartSidecar },
		guard: "destructive",
	});
	add({
		// `window.close()` used to hide behind this name, which left every other
		// window (and its running agents) open while reporting the app as quit.
		name: "quit",
		aliases: ["exit"],
		label: t("cmd.quit"),
		description: t("cmd.quit.desc"),
		category: "other",
		affordance: { kind: "action", run: () => window.omp.app.quit() },
		guard: "destructive",
	});
	add({
		name: "retry",
		label: t("cmd.retry"),
		description: t("cmd.retry.desc"),
		category: "session",
		shortcut: kbd("retry"),
		affordance: { kind: "action", run: () => ctx.retryTurn() },
		guard: "turn",
	});
	add({
		name: "resend",
		label: t("cmd.resend"),
		description: t("cmd.resend.desc"),
		category: "session",
		affordance: { kind: "action", run: () => ctx.retryLastTurn() },
		guard: "turn",
	});
	// /queue focuses the composer prefilled with the yield-queue shorthand
	// ("-> ") via the same omp:fill-composer channel the starter cards and the
	// session-tree draft restore use — the composer submits the queue over RPC.
	add({
		name: "queue",
		label: t("cmd.queue"),
		description: t("cmd.queue.desc"),
		category: "session",
		affordance: { kind: "action", run: () => prefillQueueShorthand() },
	});
	add({
		name: "dequeue",
		label: t("hotkeys.row.dequeue"),
		category: "session",
		shortcut: kbd("dequeue"),
		affordance: {
			kind: "action",
			run: () => restoreQueuedMessages(() => toast({ variant: "info", message: t("input.dequeueEmpty") })),
		},
	});
	// The composer's own actions, which had chords or buttons but no palette row. Stop is the toolbar's Stop (Esc);
	// History, Expand and Attach are answered by the focused composer (`lib/composer-actions.ts`).
	add({
		name: "stop",
		label: t("cmd.stop"),
		description: t("cmd.stop.desc"),
		category: "session",
		shortcut: "Esc",
		affordance: { kind: "action", run: () => abortActiveTurn(undefined, undefined, "palette") },
	});
	add({
		name: "history",
		label: t("cmd.history"),
		description: t("cmd.history.desc"),
		category: "session",
		shortcut: "⌃R",
		affordance: { kind: "action", run: () => requestComposerAction("history") },
	});
	add({
		name: "expand",
		label: t("cmd.expand"),
		description: t("cmd.expand.desc"),
		category: "session",
		shortcut: "⌃G",
		affordance: { kind: "action", run: () => requestComposerAction("expand") },
	});
	add({
		name: "attach",
		label: t("cmd.attach"),
		description: t("cmd.attach.desc"),
		category: "session",
		affordance: { kind: "action", run: () => requestComposerAction("attach") },
	});

	// ═══════════════════════════════════════════════════════════════════
	// MODEL
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "model",
		label: t("cmd.model"),
		description: t("cmd.model.desc"),
		category: "model",
		aliases: ["models"],
		shortcut: kbd("model.select"),
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "switch",
		label: t("cmd.switch"),
		description: t("cmd.switch.desc"),
		category: "model",
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "model cycle",
		label: t("cmd.model.cycle"),
		description: t("cmd.model.cycle.desc"),
		category: "model",
		shortcut: kbd("model.cycleForward"),
		affordance: { kind: "action", run: () => ctx.rpc.cycleModel() },
	});
	add({
		name: "thinking cycle",
		label: t("cmd.thinking.cycle"),
		description: t("cmd.thinking.cycle.desc"),
		category: "model",
		shortcut: kbd("thinking.cycle"),
		affordance: { kind: "action", run: () => ctx.rpc.cycleThinkingLevel() },
	});
	add({
		name: "fast",
		label: t("cmd.fast"),
		description: t("cmd.fast.desc"),
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => ctx.fastModeEnabled,
			set: e =>
				runSessionCommand(ctx.rpc.setFastMode(e), "Fast mode", data => {
					const d = data as { enabled?: boolean; active?: boolean } | undefined;
					useModelStore.setState({ fastModeEnabled: d?.enabled ?? e, fastModeActive: d?.active ?? false });
				}),
		},
	});
	add({
		name: "slow",
		label: t("cmd.slow"),
		description: t("cmd.slow.desc"),
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => useModelStore.getState().slowModeEnabled,
			set: e =>
				runSessionCommand(boundRpc.setSlowMode(e), t("cmd.slow"), data => {
					const d = data as { enabled?: boolean } | undefined;
					useModelStore.setState({ slowModeEnabled: d?.enabled ?? e });
				}),
		},
	});
	add({
		name: "prewalk",
		label: t("cmd.prewalk"),
		description: t("cmd.prewalk.desc"),
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => ctx.prewalkArmed,
			set: e =>
				runSessionCommand(ctx.rpc.setPrewalk(e), t("cmd.prewalk"), data => {
					const d = data as { enabled?: boolean } | undefined;
					useSessionStore.setState({ prewalkArmed: d?.enabled ?? e });
				}),
		},
	});
	add({
		name: "advisor",
		label: t("cmd.advisor"),
		description: t("cmd.advisor.desc"),
		category: "model",
		affordance: {
			kind: "submenu",
			items: [
				subAction("advisor on", () => setAdvisor(true)),
				subAction("advisor off", () => setAdvisor(false)),
				// Text reports stay forwarded until a structured RPC exists (contract).
				sub("advisor status", "/advisor status"),
				sub("advisor dump", "/advisor dump"),
			],
		},
	});
	add({
		name: "model-roles",
		label: t("cmd.modelRoles"),
		description: t("cmd.modelRoles.desc"),
		category: "model",
		affordance: { kind: "window", open: () => ctx.openSettings("models:roles") },
	});
	add({
		name: "model-compare",
		label: t("cmd.modelCompare"),
		description: t("cmd.modelCompare.desc"),
		category: "model",
		aliases: ["compare"],
		affordance: { kind: "window", open: () => ctx.openSettings("models:compare") },
	});
	add({
		name: "benchmark",
		label: t("cmd.benchmark"),
		description: t("cmd.benchmark.desc"),
		category: "model",
		aliases: ["bench", "performance"],
		affordance: { kind: "window", open: ctx.openBenchmark },
	});

	// ═══════════════════════════════════════════════════════════════════
	// CONTEXT
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "compact",
		label: t("cmd.compact"),
		description: t("cmd.compact.desc"),
		category: "context",
		affordance: {
			kind: "action",
			run: async () => {
				const { response: res, cancelled } = await runManualMaintenance("compact", () => ctx.rpc.compact());
				if (cancelled) {
					toast({ variant: "info", message: t("command.compactCancelled") });
					return;
				}
				if (!res.success) throw new Error(res.error);
				await ctx.hydrateSession();
				toast({ variant: "success", message: t("command.compactedTitle") });
			},
		},
		guard: "destructive",
	});
	add({
		name: "shake",
		label: t("cmd.shake"),
		description: t("cmd.shake.desc"),
		category: "context",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "shake elide",
					label: t("cmd.shake.elide"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("elide") },
					guard: "destructive",
				},
				{
					name: "shake images",
					label: t("cmd.shake.images"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("images") },
					guard: "destructive",
				},
				{
					name: "shake thinking",
					label: t("cmd.shake.thinking"),
					category: "extensions",
					affordance: { kind: "action", run: () => shakeContextFromGui("thinking") },
					guard: "destructive",
				},
			],
		},
	});
	add({
		name: "context",
		label: t("cmd.context"),
		description: t("cmd.context.desc"),
		category: "insights",
		affordance: { kind: "window", open: () => ctx.openInsights("stats", "session") },
	});
	add({
		name: "auto-compact",
		label: t("cmd.autoCompact"),
		description: t("cmd.autoCompact.desc"),
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoCompaction,
			set: e =>
				runSessionCommand(ctx.rpc.setAutoCompaction(e), "Auto-compaction", data =>
					useSettingsStore
						.getState()
						.update({ autoCompaction: (data as { enabled?: boolean } | undefined)?.enabled ?? e }),
				),
		},
	});
	add({
		name: "auto-retry",
		label: t("cmd.autoRetry"),
		description: t("cmd.autoRetry.desc"),
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoRetry,
			set: e =>
				runSessionCommand(ctx.rpc.setAutoRetry(e), "Auto-retry", data =>
					useSettingsStore
						.getState()
						.update({ autoRetry: (data as { enabled?: boolean } | undefined)?.enabled ?? e }),
				),
		},
	});
	add({
		name: "fresh",
		label: t("cmd.fresh"),
		description: t("cmd.fresh.desc"),
		category: "context",
		affordance: { kind: "action", run: () => freshGuarded() },
		guard: "destructive",
	});

	// ═══════════════════════════════════════════════════════════════════
	// TOOLS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "tools",
		label: t("cmd.tools"),
		description: t("cmd.tools.desc"),
		category: "tools",
		affordance: { kind: "window", open: () => useUiStore.getState().openActiveTools() },
	});
	add({
		name: "computer",
		label: t("cmd.computer"),
		description: t("cmd.computer.desc"),
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				// Same set_setting mutation the SettingsWindow computer.enabled toggle uses.
				subAction("computer on", () => writeSetting("computer.enabled", true, t("computer.on"))),
				subAction("computer off", () => writeSetting("computer.enabled", false, t("computer.off"))),
				subAction("computer status", async () => {
					const value = await readSetting("computer.enabled");
					toast({
						variant: "info",
						title: t("cmd.computer"),
						message: t(value === true ? "computer.on" : "computer.off"),
					});
				}),
			],
		},
	});
	add({
		name: "browser",
		label: t("cmd.browser"),
		description: t("cmd.browser.desc"),
		category: "tools",
		affordance: {
			kind: "submenu",
			// Same set_setting mutation the SettingsWindow browser.headless toggle uses.
			items: [
				subAction("browser headless", () => writeSetting("browser.headless", true, t("browser.headlessOn"))),
				subAction("browser visible", () => writeSetting("browser.headless", false, t("browser.visibleOn"))),
			],
		},
	});
	add({
		name: "force",
		label: t("cmd.force"),
		description: t("cmd.force.desc"),
		category: "tools",
		affordance: { kind: "picker", open: () => useUiStore.getState().openForceTool() },
	});
	add({
		name: "todo",
		label: t("cmd.todo"),
		description: t("cmd.todo.desc"),
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				subAction("todo edit", () => {
					// The dock card self-hides with no todos — say so instead of no-oping.
					const hasTodos = useTodoStore.getState().phases.some(phase => phase.tasks.length > 0);
					if (!hasTodos) {
						toast({ variant: "info", message: translate("todoPanel.empty") });
						return;
					}
					// A finished list has left the dock; editing it is an explicit ask to bring it back.
					useTodoStore.getState().revealClosed();
					ctx.focusDockCard("todo");
				}),
				subAction("todo copy", () => copyTodosToClipboard()),
				subAction("todo export", () => exportTodos()),
				subAction("todo import", () => importTodosFromFile()),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// PROVIDERS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "providers",
		label: t("cmd.providers"),
		description: t("cmd.providers.desc"),
		category: "providers",
		aliases: ["setup"],
		affordance: { kind: "window", open: ctx.openProviders },
	});
	add({
		name: "add-provider",
		label: t("cmd.addProvider"),
		description: t("cmd.addProvider.desc"),
		category: "providers",
		aliases: ["provider-config", "custom-provider"],
		affordance: { kind: "window", open: ctx.openProviderConfig },
	});
	add({
		name: "usage",
		label: t("cmd.usage"),
		description: t("cmd.usage.desc"),
		category: "insights",
		affordance: { kind: "window", open: () => ctx.openInsights("usage") },
	});
	add({
		name: "login",
		label: t("cmd.openLogin"),
		description: t("cmd.openLogin.desc"),
		category: "providers",
		affordance: { kind: "window", open: ctx.openProviders },
	});
	add({
		name: "logout",
		label: t("cmd.openLogout"),
		description: t("cmd.openLogout.desc"),
		category: "providers",
		affordance: { kind: "window", open: ctx.openProviders },
	});

	// ═══════════════════════════════════════════════════════════════════
	// EXTENSIONS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "skills",
		label: t("cmd.skills"),
		description: t("cmd.skills.desc"),
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openSettings("tools:skills") },
	});
	add({
		name: "hooks",
		label: t("cmd.hooks"),
		description: t("cmd.hooks.desc"),
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openSettings("tools:hooks") },
	});
	add({
		name: "commands",
		label: t("cmd.commands"),
		description: t("cmd.commands.desc"),
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openSettings("tools:commands") },
	});
	add({
		name: "mcp",
		label: t("cmd.mcp"),
		description: t("cmd.mcp.desc"),
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "mcp panel",
					label: t("cmd.mcp.panel"),
					description: t("cmd.mcp.panel.desc"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openSettings("tools:mcp") },
				},
				{
					name: "mcp list",
					label: t("cmd.mcp.list"),
					description: t("cmd.mcp.list.desc"),
					category: "extensions",
					typedAsPrompt: true,
					affordance: { kind: "window", open: () => ctx.openSettings("tools:mcp") },
				},
				// add/test are covered natively by the MCP tab (wizard + cards); reauth with a name signs in from here.
				subWindow("mcp add", () => ctx.openSettings("tools:mcp")),
				subAction("mcp remove", args => runMcpAction("remove", args)),
				subWindow("mcp test", () => ctx.openSettings("tools:mcp")),
				subAction("mcp enable", args => runMcpAction("enable", args)),
				subAction("mcp disable", args => runMcpAction("disable", args)),
				subAction("mcp reauth", args => runMcpReauth(args)),
				sub("mcp unauth", "/mcp unauth ", "<name>"),
				subAction("mcp reconnect", args => runMcpAction("reconnect", args)),
				subAction("mcp reload", () => runMcpReload()),
				sub("mcp resources", "/mcp resources"),
				sub("mcp prompts", "/mcp prompts"),
				sub("mcp notifications", "/mcp notifications"),
				sub("mcp smithery-search", "/mcp smithery-search ", "<keyword>"),
				sub("mcp smithery-login", "/mcp smithery-login"),
				sub("mcp smithery-logout", "/mcp smithery-logout"),
				sub("mcp help", "/mcp help"),
			],
		},
	});
	add({
		name: "marketplace",
		label: t("cmd.marketplace"),
		description: t("cmd.marketplace.desc"),
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "marketplace panel",
					label: t("cmd.marketplace.panel"),
					description: t("cmd.marketplace.panel.desc"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openSettings("tools:marketplaces") },
				},
				{
					name: "marketplace list",
					label: t("cmd.marketplace.list"),
					description: t("cmd.marketplace.list.desc"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openSettings("tools:marketplaces") },
				},
				subAction("marketplace add", args => runMarketplaceAction("add", args)),
				subAction("marketplace remove", args => runMarketplaceAction("remove", args)),
				subAction("marketplace update", args => runMarketplaceAction("update", args)),
				subWindow("marketplace discover", () => ctx.openSettings("tools:marketplaces")),
				subWindow("marketplace install", () => ctx.openSettings("tools:marketplaces")),
				subAction("marketplace uninstall", args => runMarketplaceAction("uninstall", args)),
				{
					name: "marketplace installed",
					label: t("cmd.marketplace.installed"),
					description: t("cmd.marketplace.installed.desc"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openSettings("tools:plugins") },
				},
				subAction("marketplace upgrade", args => runMarketplaceAction("upgrade", args)),
				sub("marketplace help", "/marketplace help"),
			],
		},
	});
	add({
		name: "plugins",
		label: t("cmd.plugins"),
		description: t("cmd.plugins.desc"),
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "plugins panel",
					label: t("cmd.plugins.panel"),
					description: t("cmd.plugins.panel.desc"),
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openSettings("tools:plugins") },
				},
				sub("plugins list", "/plugins list"),
				subAction("plugins enable", args => runPluginEnabled(true, args)),
				subAction("plugins disable", args => runPluginEnabled(false, args)),
			],
		},
	});
	add({
		name: "reload-plugins",
		label: t("cmd.reloadPlugins"),
		description: t("cmd.reloadPlugins.desc"),
		category: "extensions",
		affordance: { kind: "action", run: () => reloadPluginsFromGui(ctx.hydrateSession) },
	});
	add({
		name: "memory",
		label: t("cmd.memory"),
		description: t("cmd.memory.desc"),
		category: "extensions",
		// The Memory page (Settings › Memory); stock's `/memory` subcommands (they mutate stock's own backends) are not offered.
		affordance: { kind: "window", open: () => ctx.openSettings("memory") },
	});
	add({
		name: "security",
		label: t("cmd.security"),
		description: t("cmd.security.desc"),
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				sub("security plan", "/security plan"),
				sub("security scan", "/security scan"),
				sub("security status", "/security status"),
				sub("security cancel", "/security cancel"),
				sub("security scans", "/security scans"),
				sub("security show", "/security show ", "<id>"),
				sub("security import", "/security import ", "<path>"),
				sub("security export", "/security export"),
				sub("security validate", "/security validate ", "<id>"),
				sub("security compare", "/security compare"),
				sub("security disposition", "/security disposition"),
			],
		},
	});
	add({
		name: "templates",
		label: t("cmd.templates"),
		description: t("cmd.templates.desc"),
		category: "extensions",
		aliases: ["prompt-templates"],
		affordance: { kind: "window", open: () => ctx.openSettings("tools:templates") },
	});
	add({
		name: "ssh",
		label: t("cmd.ssh"),
		description: t("cmd.ssh.desc"),
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				// The native page owns host selection, validation, and confirmation.
				subWindow("ssh list", () => ctx.openSettings("connections:ssh")),
				subWindow("ssh add", () => ctx.openSettings("connections:ssh")),
				subWindow("ssh remove", () => ctx.openSettings("connections:ssh")),
				sub("ssh help", "/ssh help"),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// MODES
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "plan",
		label: t("cmd.plan"),
		description: t("cmd.plan.desc"),
		category: "modes",
		shortcut: kbd("plan.toggle"),
		affordance: {
			kind: "toggle",
			get: () => ctx.planModeEnabled,
			set: e =>
				runSessionCommand(ctx.rpc.setPlanMode(e), "Plan mode", data => {
					const d = data as { enabled?: boolean } | undefined;
					useSessionStore.setState({ planModeEnabled: d?.enabled ?? e });
				}),
		},
	});
	add({
		name: "goal",
		label: t("cmd.goal"),
		description: t("cmd.goal.desc"),
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes("goal") },
	});
	add({
		name: "autopilot",
		label: t("cmd.autopilot"),
		description: t("cmd.autopilot.desc"),
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes("autopilot") },
	});
	// The Modes window is the native form of TUI /modes; without this row the
	// sidecar-advertised command merges in as a dead "TUI-only" entry.
	add({
		name: "modes",
		label: t("cmd.modes"),
		description: t("cmd.modes.desc"),
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes() },
	});
	// Run settings is the Run chip's popover: Mode, Thinking, Tool approval, Delegation, Fast mode, Advanced.
	add({
		name: "run",
		label: t("cmd.run"),
		description: t("cmd.run.desc"),
		category: "modes",
		aliases: ["run-settings", "approval", "delegation"],
		affordance: { kind: "window", open: () => ctx.openModes() },
	});

	// ═══════════════════════════════════════════════════════════════════
	// WORKSPACE
	// ═══════════════════════════════════════════════════════════════════
	// /dirs and /remove-dir open the workspace-directories dialog (it lists the
	// roots and confirms removals inline); /add-dir and /move go straight to
	// the native directory picker + RPC, with the same client-side busy guard
	// as /new and /clear (the server also refuses with the "busy" code).
	const workspaceMutationBusy = (): boolean => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
			return true;
		}
		return false;
	};
	const pickAndAdd = async (): Promise<void> => {
		if (workspaceMutationBusy()) return;
		const path = await pickFocusedTabDirectory();
		if (path) await addWorkspaceDirectory(path);
	};
	const pickAndMove = async (): Promise<void> => {
		if (workspaceMutationBusy()) return;
		const path = await pickFocusedTabDirectory();
		if (path) await moveSessionTo(path);
	};
	add({
		name: "move",
		label: t("cmd.move"),
		description: t("cmd.move.desc"),
		category: "workspace",
		affordance: { kind: "picker", open: () => void pickAndMove() },
	});
	add({
		name: "add-dir",
		label: t("cmd.addDir"),
		description: t("cmd.addDir.desc"),
		category: "workspace",
		affordance: { kind: "picker", open: () => void pickAndAdd() },
	});
	add({
		name: "remove-dir",
		label: t("cmd.removeDir"),
		description: t("cmd.removeDir.desc"),
		category: "workspace",
		affordance: { kind: "window", open: () => ctx.openSettings("workspace") },
	});
	const openProjectBusy = (): boolean => {
		if (!useSessionStore.getState().isStreaming) return false;
		toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
		return true;
	};
	add({
		name: "open-project",
		label: t("sidebar.project.open"),
		category: "workspace",
		affordance: {
			kind: "picker",
			open: () => {
				if (openProjectBusy()) return;
				void selectFocusedTabProject().catch(error =>
					toastError({ title: t("titlebar.openProjectFailed"), error }),
				);
			},
		},
	});
	add({
		name: "dirs",
		label: t("cmd.dirs"),
		description: t("cmd.dirs.desc"),
		category: "workspace",
		affordance: { kind: "window", open: () => ctx.openSettings("workspace") },
	});
	add({
		name: "git",
		label: t("cmd.git"),
		description: t("cmd.git.desc"),
		category: "panel",
		shortcut: kbd("panel.diff"),
		affordance: { kind: "window", open: () => useUiStore.getState().setPanelTab("diff") },
	});
	for (const view of ["terminal", "preview", "files"] as const) {
		add({
			name: view,
			label: t(`panel.tabs.${view}`),
			description: t("panel.title"),
			category: "panel",
			shortcut: kbd(`panel.${view}`),
			affordance: { kind: "window", open: () => useUiStore.getState().setPanelTab(view) },
		});
	}
	// The session views that open as sheets (`jobs` and `tree` are their own commands above and below).
	for (const [name, view] of [
		["logs", "logs"],
		["plan-document", "plan"],
		["work-tree", "work"],
	] as const) {
		add({
			name,
			label: t(`viewSheet.${view}`),
			description: t(`viewSheet.${view}.desc`),
			category: "panel",
			affordance: { kind: "window", open: () => useUiStore.getState().openViewSheet(view) },
		});
	}
	add({
		name: "toggle-panel",
		label: t("hotkeys.row.panel"),
		category: "panel",
		shortcut: kbd("panel.toggle"),
		affordance: { kind: "action", run: () => useUiStore.getState().togglePanel() },
	});

	// ═══════════════════════════════════════════════════════════════════
	// VIEW
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "theme",
		label: t("cmd.theme"),
		description: t("cmd.theme.desc"),
		category: "settings",
		affordance: { kind: "picker", open: ctx.openThemePicker },
	});
	add({
		name: "toggle-sidebar",
		label: t("hotkeys.row.sidebar"),
		category: "settings",
		shortcut: kbd("sidebar.toggle"),
		affordance: { kind: "action", run: () => useUiStore.getState().toggleSidebar() },
	});
	add({
		name: "toggle-thinking-blocks",
		label: t("hotkeys.row.thinkingToggle"),
		category: "settings",
		shortcut: kbd("thinking.toggle"),
		affordance: {
			kind: "action",
			run: () => setDisplayPreference("hideThinkingBlock", !readDisplayPreference("hideThinkingBlock")),
		},
	});
	add({
		name: "focus-work-board",
		label: t("hotkeys.row.workBoard"),
		category: "settings",
		shortcut: kbd("board.focus"),
		affordance: { kind: "action", run: () => void focusWorkBoard() },
	});
	add({
		name: "toggle-work-board",
		label: t("cmd.workBoard"),
		description: t("cmd.workBoard.desc"),
		category: "settings",
		affordance: {
			kind: "action",
			run: () => useUiStore.getState().setWorkBoard(!useUiStore.getState().workBoard),
		},
	});
	add({
		name: "expand-tools",
		label: t("hotkeys.row.expandTools"),
		category: "settings",
		shortcut: kbd("tools.expand"),
		affordance: { kind: "action", run: () => useUiStore.getState().toggleToolsExpandAll() },
	});
	add({
		name: "settings",
		label: t("cmd.settings"),
		description: t("cmd.settings.desc"),
		category: "settings",
		shortcut: kbd("settings"),
		affordance: { kind: "window", open: () => ctx.openSettings() },
	});
	add({
		name: "output-style",
		label: t("cmd.outputStyle"),
		description: t("cmd.outputStyle.desc"),
		category: "settings",
		aliases: ["style"],
		affordance: {
			kind: "submenu",
			items: OUTPUT_STYLE_IDS.map(style => ({
				...subAction(`output-style ${style}`, () => useOutputStyleStore.getState().setStyle(style)),
				category: "settings" as const,
			})),
		},
	});
	add({
		name: "autoclear",
		label: t("cmd.autoclear"),
		description: t("cmd.autoclear.desc"),
		category: "settings",
		affordance: {
			kind: "submenu",
			items: [
				{ ...subAction("autoclear on", args => setIdleCompaction(true, args)), category: "settings" as const },
				{ ...subAction("autoclear off", () => setIdleCompaction(false)), category: "settings" as const },
				{
					...subWindow("autoclear settings", () => ctx.openSettings("agent:setting-compaction.idleEnabled")),
					category: "settings" as const,
				},
			],
		},
	});
	add({
		name: "websearch",
		label: t("cmd.websearch"),
		description: t("cmd.websearch.desc"),
		category: "settings",
		affordance: { kind: "window", open: () => ctx.openSettings("models:setting-providers.webSearch") },
	});
	add({
		name: "connect",
		label: t("cmd.connect"),
		description: t("cmd.connect.desc"),
		category: "settings",
		affordance: { kind: "window", open: () => ctx.openSettings("connections:remote") },
	});
	add({
		name: "doctor",
		label: t("cmd.doctor"),
		description: t("cmd.doctor.desc"),
		category: "settings",
		affordance: { kind: "window", open: () => ctx.openSettings("updates:setting-machine-setup") },
	});
	add({
		name: "stats",
		label: t("cmd.stats"),
		description: t("cmd.stats.desc"),
		category: "insights",
		affordance: { kind: "window", open: () => ctx.openInsights("stats", "all") },
	});
	add({
		name: "feedback",
		label: t("cmd.feedback"),
		description: t("cmd.feedback.desc"),
		category: "help",
		affordance: { kind: "window", open: ctx.openFeedback },
	});
	add({
		name: "jobs",
		label: t("cmd.jobs"),
		description: t("cmd.jobs.desc"),
		category: "panel",
		affordance: { kind: "window", open: () => useUiStore.getState().openJobs() },
	});
	add({
		name: "changelog",
		label: t("cmd.changelog"),
		description: t("cmd.changelog.desc"),
		category: "help",
		affordance: { kind: "window", open: () => useUiStore.getState().openChangelog() },
	});
	add({
		name: "check-updates",
		label: t("cmd.checkUpdates"),
		description: t("cmd.checkUpdates.desc"),
		category: "help",
		affordance: { kind: "action", run: () => checkForUpdatesInPlace() },
	});
	add({
		name: "copy",
		label: t("cmd.copy"),
		description: t("cmd.copy.desc"),
		category: "session",
		affordance: { kind: "action", run: args => copyFromChat(args) },
	});
	add({
		name: "hotkeys",
		label: t("cmd.hotkeys"),
		description: t("cmd.hotkeys.desc"),
		category: "help",
		shortcut: kbd("hotkeys"),
		affordance: { kind: "window", open: () => ctx.openSettings("keyboard") },
	});
	add({
		name: "extensions",
		label: t("cmd.extensions"),
		description: t("cmd.extensions.desc"),
		category: "settings",
		aliases: ["status"],
		affordance: { kind: "window", open: () => ctx.openSettings("tools:skills") },
	});
	add({
		name: "agents",
		label: t("cmd.agents"),
		description: t("cmd.agents.desc"),
		category: "agents",
		affordance: { kind: "window", open: () => ctx.openAgents("definitions") },
	});
	add({
		name: "hub",
		label: t("cmd.hub"),
		description: t("cmd.hub.desc"),
		category: "agents",
		shortcut: kbd("agents.hub"),
		affordance: { kind: "window", open: () => ctx.openAgents("live") },
	});
	add({
		name: "prs",
		label: t("cmd.prCenter"),
		description: t("cmd.prCenter.desc"),
		category: "agents",
		shortcut: kbd("pr.center"),
		affordance: { kind: "window", open: () => ctx.openAgents("prs") },
	});
	add({
		name: "github",
		label: t("cmd.github"),
		description: t("cmd.github.desc"),
		category: "agents",
		affordance: { kind: "window", open: () => ctx.openAgents("github") },
	});

	// ═══════════════════════════════════════════════════════════════════
	// NATIVE INTERACTIVE SURFACES
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "btw",
		label: t("cmd.btw"),
		description: t("cmd.btw.desc"),
		category: "session",
		affordance: {
			kind: "action",
			argUsage: "<question>",
			run: question => {
				const trimmed = question?.trim();
				if (!trimmed) {
					toast({ variant: "info", message: translate("btw.usage") });
					return;
				}
				useUiStore.getState().openBtw(trimmed);
			},
		},
	});
	add({
		name: "tan",
		label: t("cmd.tan"),
		description: t("cmd.tan.desc"),
		category: "agents",
		affordance: { kind: "action", argUsage: "<work>", run: work => dispatchTan(work) },
	});
	add({
		name: "omfg",
		label: t("cmd.omfg"),
		description: t("cmd.omfg.desc"),
		category: "other",
		affordance: { kind: "action", argUsage: "<complaint>", run: complaint => forgeTtsrRule(complaint) },
	});
	add({
		name: "debug",
		label: t("cmd.debug"),
		description: t("cmd.debug.desc"),
		category: "other",
		affordance: { kind: "window", open: () => useUiStore.getState().openDebug() },
	});
	add({
		name: "live",
		label: t("cmd.live"),
		description: t("cmd.live.desc"),
		category: "other",
		affordance: { kind: "window", open: () => useUiStore.getState().openLive() },
	});
	add({
		name: "open",
		label: t("cmd.open"),
		description: t("cmd.open.desc"),
		category: "session",
		affordance: {
			kind: "action",
			// Stock `/open [link]` (builtin-collaboration.ts) opens the newest
			// http(s) link of an assistant message; stock's extractor runs in the bridge.
			run: async args => {
				const arg = args?.trim().toLowerCase() ?? "";
				if (arg && arg !== "link" && arg !== "url") {
					toast({ variant: "info", message: translate("cmd.open.usage") });
					return;
				}
				const response = await boundRpc.getLastLink();
				if (!response.success) throw new Error(response.error);
				const href = (response.data as { href?: string | null } | undefined)?.href;
				if (!href) {
					toast({ variant: "info", message: translate("cmd.open.none") });
					return;
				}
				await window.omp.system.openExternal(href);
				toast({ variant: "info", message: translate("cmd.open.opening", { href }) });
			},
		},
	});
	// Stock serves these only in its terminal UI (a `handleTui` without `handle`),
	// so RPC would hand the text to the model. Say where they run instead.
	for (const [name, reason] of [
		["collab", "unavailable.collab"],
		["join", "unavailable.collab"],
		["leave", "unavailable.collab"],
		["record", "unavailable.record"],
	] as const) {
		add({
			name,
			label: `/${name}`,
			description: t(`cmd.${name}.desc`),
			category: "other",
			affordance: { kind: "unavailable", reason: t(reason) },
		});
	}
	// Stock's `/cleanse` board needs its TUI; `omp cleanse [request] [flags]` runs the same pipeline
	// (stock `commands/cleanse.ts`) in the tab's own terminal, in the tab's folder (C164).
	add({
		name: "cleanse",
		label: "/cleanse",
		description: t("cmd.cleanse.desc"),
		category: "other",
		affordance: {
			kind: "action",
			run: async args => {
				const tabs = useTabsStore.getState();
				const tabId = focusedSessionRuntime()?.tabId ?? tabs.activeTabId;
				const tab = tabs.tabs.find(entry => entry.id === tabId);
				if (!tab) return;
				const request = args?.trim();
				await runInTerminal(tab.id, request ? `omp cleanse ${request}` : "omp cleanse");
			},
		},
	});
	add({
		name: "pause",
		label: t("cmd.pause"),
		description: t("cmd.pause.desc"),
		category: "agents",
		affordance: {
			kind: "toggle",
			get: () => useSessionStore.getState().agentsPaused,
			set: async enabled => {
				await runSessionCommand(boundRpc.setAgentsPaused(enabled), t("cmd.pause"), data => {
					const state = data as { paused: boolean; pausedAt?: number };
					useSessionStore.setState({ agentsPaused: state.paused, agentsPausedAt: state.pausedAt ?? null });
				});
			},
		},
	});
	add({
		name: "plan-review",
		label: t("cmd.planReview"),
		description: t("cmd.planReview.desc"),
		category: "modes",
		affordance: {
			kind: "action",
			run: () => {
				// The dock card only renders while plan mode is on — point at the toggle otherwise.
				if (!useSessionStore.getState().planModeEnabled) {
					toast({ variant: "info", message: translate("planPanel.statusOff") });
					return;
				}
				ctx.focusDockCard("plan");
			},
		},
	});
	add({
		name: "guided-goal",
		label: t("cmd.guidedGoal"),
		description: t("cmd.guidedGoal.desc"),
		category: "modes",
		affordance: {
			kind: "action",
			run: async initial => {
				const response = await boundRpc.guidedGoal(initial);
				if (!response.success) throw new Error(response.error);
			},
		},
		guard: "turn",
	});

	// Merge sidecar-advertised commands not already covered. A name claimed by
	// a native item — as its name OR one of its aliases — is dropped: `/models`
	// and `/modes` must not appear as dead rows next to the working picker.
	for (const cmd of ctx.availableCommands) {
		if (claimed.has(cmd.name)) continue;
		// Keep terminal-only commands visible as disabled rows. The palette is
		// the GUI's command index; hiding a command makes its client limitation opaque.
		if (cmd.textModeExecutable === false) {
			add({
				name: cmd.name,
				label: `/${cmd.name}`,
				description: cmd.description,
				category: "other",
				affordance: { kind: "unavailable", reason: t("palette.tuiOnly") },
			});
			continue;
		}
		add({
			name: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description,
			category: "other",
			affordance: p(`/${cmd.name}${cmd.input?.hint ? " " : ""}`, cmd.input?.hint),
		});
	}

	return items;
}

/** Hand text to the composer and focus it (the omp:fill-composer channel also
 *  serves starter cards, dequeue restore, and session-tree restore). */
export function prefillComposer(text: string): void {
	window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text } }));
}

/** /queue prefill: focus the composer with the yield-queue shorthand ("-> "). */
function prefillQueueShorthand(): void {
	prefillComposer("-> ");
}

/**
 * The composer text a palette row needs from the user, or null when the row can
 * run as-is. The palette has no argument entry, so a parameterized command
 * returns its own slash form for the composer instead of being dispatched
 * without its argument (which only ever produced a `Usage:` reply).
 */
export function commandArgPrefill(item: CommandMenuItem): string | null {
	const affordance = item.affordance;
	if (affordance.kind === "prompt") return affordance.argUsage === undefined ? null : affordance.text;
	if (affordance.kind === "action") return affordance.argUsage === undefined ? null : `/${item.name} `;
	return null;
}

/** /shake elide|images|thinking: confirm, then drop context via shake_context RPC;
 *  the toast carries the agent's removed summary. */
async function shakeContextFromGui(mode: "elide" | "images" | "thinking"): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const confirmKey =
		mode === "images" ? "shake.confirmImages" : mode === "thinking" ? "shake.confirmThinking" : "shake.confirmElide";
	if (!window.confirm(translate(confirmKey))) return;
	const response = await rpc.shakeContext(mode);
	if (!response.success) {
		toastError({ title: translate("cmd.shake"), error: response });
		return;
	}
	const removed = (response.data as { removed?: string } | undefined)?.removed;
	toast({ variant: "success", title: translate("cmd.shake"), message: removed ?? translate("shake.success") });
}

/** /fresh: rotate provider stream state via the fresh RPC; the server's busy
 *  refusal (mid-stream) rides a warning toast instead of failing hard. */
async function freshProviderStateFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.fresh();
	if (!response.success) {
		toastError({ title: translate("cmd.fresh"), error: response, variant: "warning" });
		return;
	}
	toast({ variant: "success", message: translate("fresh.success") });
}

/** /reload-plugins: reload plugin state via the reload_plugins RPC, toast the
 *  post-reload counts, and rehydrate so the extensions inventory refreshes. */
async function reloadPluginsFromGui(hydrate: () => Promise<void>): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.reloadPlugins();
	if (!response.success) {
		toastError({ title: translate("cmd.reloadPlugins"), error: response });
		return;
	}
	const counts = (response.data as { plugins?: number; skills?: number; commands?: number } | undefined) ?? {};
	toast({
		variant: "success",
		title: translate("cmd.reloadPlugins"),
		message: translate("reloadPlugins.success", {
			plugins: counts.plugins ?? 0,
			skills: counts.skills ?? 0,
			commands: counts.commands ?? 0,
		}),
	});
	await hydrate();
}

async function copyFromChat(args?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const kind = args?.trim().toLowerCase();
	if (!kind) {
		useUiStore.getState().openCopySelector();
		return;
	}
	if (kind !== "code" && kind !== "cmd" && kind !== "command") {
		toast({ variant: "info", message: translate("copySelector.usage") });
		return;
	}
	const response = await rpc.getCopyTargets();
	if (!response.success) throw new Error(response.error);
	const targets = (response.data as { targets?: CopyTarget[] } | undefined)?.targets ?? [];
	let target: CopyTarget | undefined;
	if (kind === "code") {
		for (const root of targets) {
			const blocks = root.children?.filter(child => child.id.includes(":code:"));
			if (blocks?.length) {
				target = blocks[blocks.length - 1];
				break;
			}
		}
	} else {
		target = targets.find(candidate => candidate.id.startsWith("cmd:"));
	}
	if (target?.content === undefined) {
		toast({
			variant: "info",
			message: translate(kind === "code" ? "copySelector.noCode" : "copySelector.noCommand"),
		});
		return;
	}
	if (!(await copyText(target.content))) throw new Error(translate("copySelector.failed"));
	toast({ variant: "success", message: target.copyMessage ?? translate("copySelector.copied") });
}

async function dispatchTan(work?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const trimmed = work?.trim();
	if (!trimmed) {
		toast({ variant: "info", message: translate("tan.usage") });
		return;
	}
	const response = await rpc.tan(trimmed);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { jobId?: string } | undefined;
	toast({ variant: "success", message: translate("tan.dispatched", { id: data?.jobId ?? "" }) });
	if (runtime) await hydrateTabSession(runtime.tabId);
	else await hydrateSession();
}

async function forgeTtsrRule(complaint?: string): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const trimmed = complaint?.trim();
	if (!trimmed) {
		toast({ variant: "info", message: translate("omfg.usage") });
		return;
	}
	const response = await rpc.omfg(trimmed);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { state?: "saved" | "rejected" | "aborted"; savedPath?: string } | undefined;
	if (data?.state === "saved") {
		toast({ variant: "success", message: translate("omfg.saved", { path: data.savedPath ?? "" }) });
	} else {
		toast({ variant: "info", message: translate(data?.state === "rejected" ? "omfg.rejected" : "omfg.aborted") });
	}
}

export async function retryFailedTurn(rpc: TabRpc): Promise<void> {
	const response = await rpc.retry();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { retried?: boolean } | undefined;
	if (!data?.retried) {
		toast({
			variant: "warning",
			title: translate("palette.retryNothing"),
			message: translate("palette.retryNothingDesc"),
		});
	}
}

/**
 * `/delete` and the palette's Delete session: the focused tab's session goes as the sidebar's delete
 * takes it — the tab closes (the window's last tab gives way to the empty start tab), then main deletes
 * the stored file once the tab's omp has exited. No session replaces it.
 */
export async function deleteSessionFromGui(): Promise<void> {
	const { tabs, activeTabId } = useTabsStore.getState();
	const tab = tabs.find(entry => entry.id === activeTabId);
	if (!tab) return;
	const session = sessionRuntimeStore<SessionStore>(tab.id, "session")?.getState() ?? useSessionStore.getState();
	// Closing a running tab would kill its turn; the sidebar refuses the same way.
	if (session.isStreaming || session.isCompacting || tab.status === "running" || tab.compacting) {
		toast({ variant: "warning", message: translate("sidebar.menu.taskRunning") });
		return;
	}
	if (!window.confirm(translate("drop.confirm"))) return;
	const sessionPath = tab.sessionPath ?? session.sessionFile ?? undefined;
	if (!(await useTabsStore.getState().closeDeletedSession(sessionPath ?? "", tab.id))) return;
	if (sessionPath)
		await (tab.device === undefined
			? window.omp.sessions.delete(sessionPath)
			: window.omp.sessions.delete(sessionPath, tab.device));
	toast({ variant: "success", message: translate("drop.success") });
}

export async function forkSessionFromGui(): Promise<void> {
	const runtime = focusedSessionRuntime();
	const rpc = runtime ? createTabRpc(runtime.command) : window.omp.rpc;
	const response = await rpc.fork();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean } | undefined;
	if (data?.cancelled) {
		toast({ variant: "info", message: translate("fork.cancelled") });
		return;
	}
	if (runtime) await hydrateTabSession(runtime.tabId);
	else await hydrateSession();
	toast({ variant: "success", message: translate("fork.success") });
}

/** Live session state a command menu reflects: the palette subscribes to it, other callers read it once. */
type CommandContextSnapshot = Pick<
	CommandRegistryContext,
	| "isStreaming"
	| "fastModeEnabled"
	| "autoCompaction"
	| "autoRetry"
	| "planModeEnabled"
	| "prewalkArmed"
	| "availableCommands"
	| "keymapOverrides"
>;

/** The one assembly of a command context: UI openers, shared session actions, and RPCs bound to `rpc`. */
export function createCommandContext(
	snapshot: CommandContextSnapshot,
	{ t, rpc, hydrateSession }: Pick<CommandRegistryContext, "t" | "hydrateSession"> & { rpc: TabRpc },
): CommandRegistryContext {
	const ui = useUiStore.getState();
	return {
		...snapshot,
		t,
		openModelPicker: ui.openModelPicker,
		openSettings: ui.openSettings,
		openProviders: ui.openProviders,
		openFeedback: ui.openFeedback,
		openRenameDialog: ui.openRenameDialog,
		openSessionPicker: ui.openSessionPicker,
		openBranchPicker: ui.openBranchPicker,
		openSessionTree: ui.openSessionTree,
		openBenchmark: ui.openBenchmark,
		openHandoffDialog,
		openThemePicker: ui.openThemePicker,
		openModes: ui.openModes,
		openAgents: ui.openAgents,
		openInsights: ui.openInsights,
		openImportDialog: ui.openImportDialog,
		openProviderConfig: ui.openProviderConfig,
		focusDockCard: ui.focusDockCard,
		retryTurn: () => retryFailedTurn(rpc),
		retryLastTurn: () =>
			retryLastTurnShared(() =>
				toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") }),
			),
		forkSession: forkSessionFromGui,
		hydrateSession,
		rpc: {
			setFastMode: enabled => rpc.setFastMode(enabled),
			setAutoCompaction: enabled => rpc.setAutoCompaction(enabled),
			setAutoRetry: enabled => rpc.setAutoRetry(enabled),
			compact: instructions => rpc.compact(instructions),
			newSession: newSessionNow,
			setPlanMode: enabled => rpc.setPlanMode(enabled),
			setPrewalk: enabled => rpc.setPrewalk(enabled),
			cycleModel: () => rpc.cycleModel(),
			cycleThinkingLevel: () => rpc.cycleThinkingLevel(),
		},
	};
}

/**
 * Build the same canonical affordance list used by CommandPalette from the
 * live stores. Non-component submit paths use this to execute GUI-native
 * builtins instead of forwarding TUI-only command text to the model.
 */
export function buildCurrentCommandMenu(availableCommands: AvailableCommand[]): CommandMenuItem[] {
	const runtime = focusedSessionRuntime();
	const session = useSessionStore.getState();
	const model = useModelStore.getState();
	const settings = useSettingsStore.getState();
	return buildCommandMenu(
		createCommandContext(
			{
				isStreaming: session.isStreaming,
				fastModeEnabled: model.fastModeEnabled,
				autoCompaction: settings.autoCompaction,
				autoRetry: settings.autoRetry,
				planModeEnabled: session.planModeEnabled,
				prewalkArmed: session.prewalkArmed,
				availableCommands,
			},
			{
				t: translate,
				rpc: runtime ? createTabRpc(runtime.command) : window.omp.rpc,
				hydrateSession: () => (runtime ? hydrateTabSession(runtime.tabId) : hydrateSession()),
			},
		),
	);
}

/**
 * Stock omp's `get_available_commands` lists only its own builtins, not the
 * modes and windows the GUI serves itself (/plan, /goal, /btw, /tan,
 * /settings, …) nor its terminal-only commands (/collab, /record, …). Append
 * those as GUI-only builtins so slash completion offers them and composer
 * submit runs their affordance (or says where they run) instead of sending
 * the text to the model.
 */
export function withGuiCommands(stock: AvailableCommand[]): AvailableCommand[] {
	const advertised = new Set(stock.flatMap(command => [command.name, ...(command.aliases ?? [])]));
	const gui: AvailableCommand[] = [];
	for (const item of buildCurrentCommandMenu(stock)) {
		const kind = item.affordance.kind;
		if (kind !== "action" && kind !== "toggle" && kind !== "picker" && kind !== "window" && kind !== "unavailable")
			continue;
		if (advertised.has(item.name) || item.aliases?.some(alias => advertised.has(alias))) continue;
		gui.push({
			name: item.name,
			aliases: item.aliases,
			description: item.description ?? item.label,
			source: "builtin",
			textModeExecutable: false,
		});
	}
	return [...stock, ...gui];
}

/** Group items into palette sections, in `COMMAND_CATEGORIES` order (empty sections omitted). */
export function groupByCategory(items: CommandMenuItem[]): Map<CommandCategory, CommandMenuItem[]> {
	const groups = new Map<CommandCategory, CommandMenuItem[]>(COMMAND_CATEGORIES.map(category => [category, []]));
	for (const item of items) groups.get(item.category)?.push(item);
	for (const [category, list] of groups) if (list.length === 0) groups.delete(category);
	return groups;
}
