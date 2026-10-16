/**
 * Composer message submission policy. Text-mode slash commands execute
 * server-side through the prompt RPC. Builtins that require an interactive
 * surface are resolved through the same GUI affordance registry as the
 * command palette, so they can never leak into model context as literal text.
 * Session-replacing commands are blocked while a turn runs. Local-only
 * server commands rehydrate after settlement so transcript/context state
 * reflects the mutation.
 */

import type { AvailableCommand, ImageContent, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { toast, toastError } from "../stores/toast";
import { buildCurrentCommandMenu, type CommandAffordance } from "./command-registry";
import { translate } from "./i18n";
import { runManualMaintenance } from "./messages";
import { unavailableSkillTokens } from "./skill-tokens";
import { parseSlashCommand } from "./slash-command";
import type { TabRpc } from "./tab-rpc";

export type ComposerSendMode = "prompt" | "steer" | "followUp";

/** Builtin slash commands that replace the session server-side. */
const SESSION_REPLACING_COMMANDS: Record<string, true> = { new: true, clear: true };
// The desktop requires a visible preview/start step even when Core exposes a
// directly executable text command, or command discovery has not completed.
// `drop` is a GUI alias for `delete`, no longer advertised by Core.
const GUI_CONFIRMATION_COMMANDS = new Set(["share", "live", "btw", "delete", "drop"]);

export type ComposerSubmit =
	/** Session-replacing command while busy — draft stays, warning toasted. */
	| { kind: "blocked" }
	/** Exact `/clear` — native clear_context RPC path (lib/messages.clearSessionContext). */
	| { kind: "clear" }
	/** A GUI-native command opened/executed its affordance synchronously. */
	| { kind: "handled" }
	/** Dispatch this lazy request; on success call {@link settleComposerResponse}. */
	| { kind: "send"; request: () => Promise<RpcResponse> };

function runGuiAffordance(affordance: CommandAffordance, args?: string): boolean {
	const reportFailure = (cause: unknown): void => {
		toastError({ title: translate("palette.failed"), error: cause });
	};
	switch (affordance.kind) {
		case "action":
			void Promise.resolve(affordance.run(args)).catch(reportFailure);
			return true;
		case "toggle":
			void Promise.resolve(affordance.set(!affordance.get())).catch(reportFailure);
			return true;
		case "picker":
		case "window":
			affordance.open();
			return true;
		case "unavailable":
			toast({ variant: "warning", message: affordance.reason || translate("unavailable.tuiOnly") });
			return false;
		case "prompt":
		case "submenu":
			toast({ variant: "warning", message: translate("unavailable.tuiOnly") });
			return false;
	}
}

function findGuiOnlyBuiltin(message: string, commands: AvailableCommand[]): AvailableCommand | undefined {
	const name = parseSlashCommand(message)?.name;
	if (!name) return undefined;
	const command = commands.find(command => command.name === name || command.aliases?.includes(name));
	if (GUI_CONFIRMATION_COMMANDS.has(name) && (!command || command.source === "builtin")) {
		return command ?? { name, source: "builtin", description: name, textModeExecutable: false };
	}
	return command?.source === "builtin" && command.textModeExecutable === false ? command : undefined;
}

export function isGuiOnlyBuiltinCommand(message: string, commands: AvailableCommand[]): boolean {
	return findGuiOnlyBuiltin(message, commands) !== undefined;
}

function runGuiOnlyBuiltin(message: string, commands: AvailableCommand[]): boolean | undefined {
	const wireCommand = findGuiOnlyBuiltin(message, commands);
	if (!wireCommand) return undefined;
	const parsed = parseSlashCommand(message);
	const name = parsed?.name ?? wireCommand.name;
	const args = parsed?.args || undefined;
	const item = buildCurrentCommandMenu(commands).find(
		candidate => candidate.name === wireCommand.name || candidate.aliases?.includes(name),
	);
	if (!item) {
		toast({ variant: "warning", message: translate("unavailable.tuiOnly") });
		return false;
	}
	return runGuiAffordance(item.affordance, args);
}

export function planComposerSubmit(input: {
	message: string;
	images: ImageContent[];
	isStreaming: boolean;
	mode: ComposerSendMode;
	commands: AvailableCommand[];
	rpc?: Pick<TabRpc, "compact" | "followUp" | "prompt" | "steer">;
	/** Runs just before a plain (non-slash, non-streaming) prompt is sent. */
	beforePrompt?: () => Promise<unknown>;
	/**
	 * Other devices may send to this tab (a shared tab, or a page on a phone), so this window's idea of
	 * "running" can be a beat stale: a plain message goes as a prompt carrying how to join a run
	 * (steer / follow-up) and the host, which holds the one authoritative run state, decides.
	 */
	hostDecides?: boolean;
}): ComposerSubmit {
	const { message, images, isStreaming, mode, commands, rpc = window.omp.rpc } = input;
	const isSlashCommand = message.startsWith("/");
	if (isSlashCommand && isStreaming) {
		const commandName = parseSlashCommand(message)?.name;
		if (commandName !== undefined && SESSION_REPLACING_COMMANDS[commandName]) {
			toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
			return { kind: "blocked" };
		}
	}
	// Typed `/clear` (no args) takes the native clear_context RPC — forwarding it
	// as prompt text would fall through the TUI-only builtin and reach the model
	// as a literal user message.
	if (isSlashCommand && message.trim() === "/clear") {
		return { kind: "clear" };
	}
	// Manual compaction can spend minutes in provider summarization. Route the
	// exact command through its dedicated RPC so it gets the compact timeout
	// instead of timing out as an 8s prompt while still blocking the RPC queue;
	// the status row shows it running with Esc and Cancel.
	if (isSlashCommand && message.trim() === "/compact") {
		return {
			kind: "send",
			request: async () => {
				const { response, cancelled } = await runManualMaintenance("compact", () => rpc.compact());
				if (!cancelled) return response;
				// The reader stopped it: the command ran its course, so no draft comes back and no failure shows.
				toast({ variant: "info", message: translate("command.compactCancelled") });
				return { type: "response", command: "compact", success: true, data: { cancelled: true } };
			},
		};
	}
	const guiHandled = isSlashCommand ? runGuiOnlyBuiltin(message, commands) : undefined;
	if (guiHandled !== undefined) return { kind: guiHandled ? "handled" : "blocked" };
	// Stock sends a `/skill:<name>` token for a skill that is off (or missing) as plain text: say so.
	for (const name of unavailableSkillTokens(message, commands))
		toast({ variant: "warning", message: translate("input.skills.off", { name }) });
	if (!isSlashCommand && input.hostDecides) {
		return {
			kind: "send",
			request: async () => {
				if (!isStreaming) await input.beforePrompt?.();
				return rpc.prompt(message, images, mode === "followUp" ? "followUp" : "steer");
			},
		};
	}
	if (!isSlashCommand && isStreaming) {
		return {
			kind: "send",
			request: () => (mode === "followUp" ? rpc.followUp(message, images) : rpc.steer(message, images)),
		};
	}
	return {
		kind: "send",
		request: async () => {
			// The automatic mode choice (lib/auto-mode-client.ts) never throws and is bounded; it runs only for a plain prompt.
			if (!isSlashCommand) await input.beforePrompt?.();
			return rpc.prompt(message, images);
		},
	};
}

/** Post-success settle: rehydrate after local-only slash commands. */
export async function settleComposerResponse(
	response: RpcResponse,
	hydrate: () => Promise<void> = hydrateSession,
): Promise<void> {
	if (!response.success) return;
	const data: unknown = response.data;
	if (
		response.command === "compact" ||
		(data !== null && typeof data === "object" && "agentInvoked" in data && data.agentInvoked === false)
	) {
		await hydrate();
	}
}
