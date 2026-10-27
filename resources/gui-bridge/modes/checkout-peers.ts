/**
 * Sessions sharing a checkout (rules: checkout-peers-core.ts, contracts: checkout-peers-contracts.ts). Main knows
 * which live sessions of this computer work in the same worktree or repository and pushes them here
 * (`checkout_peers_set`); this module then
 * - adds the `<shared-checkout>` section to every prompt (names and ids, so the agent can reach the others),
 * - judges every `tool_call` through the ledger: refuses a git command, shell write or delete that would take,
 *   overwrite or hide their work,
 * - remembers the files this session's agents changed (file tools, shell redirects, `sed -i`, `cp`/`mv`/`rm`, ...),
 *   which main reads (`checkout_status`) to tell the others which files are this session's, with the session's
 *   in-progress todo item, and tells main at once (`checkout_files`) when that set gains a file,
 * - says once, through `tool_call`'s `additionalContext`, that a peer changed a file this session just changed, or
 *   started changing one it changed earlier.
 * One module state per omp: the main agent and its subagents share the checkout, so they share the guard.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as todo from "@oh-my-pi/pi-coding-agent/tools/todo";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import {
	CHECKOUT_FILES_EVENT,
	CHECKOUT_PEERS_EVENT,
	CHECKOUT_PEERS_GET,
	CHECKOUT_PEERS_SECTION_ID,
	CHECKOUT_PEERS_SET,
	CHECKOUT_RETIRE,
	CHECKOUT_STATUS,
} from "./checkout-peers-contracts";
import { CheckoutLedger, CheckoutPeersState, checkoutSection, currentTask, retiredClaims } from "./checkout-peers-core";
import { emit } from "./shared";

/** Main's spelling of a path: it resolves top levels with realpath, and a session's cwd may go through a symlink. */
const host = {
	realpath: (path: string) => fs.realpathSync.native(path),
	isDirectory: (path: string) => {
		try {
			return fs.statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
};

const state = new CheckoutPeersState();
const ledger = new CheckoutLedger();

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, CHECKOUT_PEERS_SECTION_ID, () => checkoutSection(state.peers));
	pi.on("tool_call", (event, ctx) => {
		const verdict = ledger.call(event.toolName, event.input, ctx.cwd, state.peers, host, event.toolCallId);
		if ("block" in verdict) return { block: true, reason: verdict.block };
		// Main learns of a new claim now, not at its next sweep, so the others' guards see the file within a pass.
		if (verdict.gained) emit({ type: CHECKOUT_FILES_EVENT });
		return verdict.notice ? { additionalContext: verdict.notice } : undefined;
	});
	// The write has landed: main reads it now. Until then the claim cannot be retired (git may not show it yet).
	pi.on("tool_result", event => {
		if (ledger.settle(event.toolCallId)) emit({ type: CHECKOUT_FILES_EVENT });
		return undefined;
	});
	// A call stock refused after the hook (a denied approval) never reports back; the run's end settles it.
	pi.on("agent_end", () => {
		if (ledger.settleAll()) emit({ type: CHECKOUT_FILES_EVENT });
	});
}

interface TaskSession {
	sessionManager: { getBranch(): unknown[] };
}

/** The in-progress todo item of the session's branch; none when stock's reader is missing or throws. */
function readTask(session: TaskSession): string | undefined {
	const read = (todo as { getLatestTodoPhasesFromEntries?: (branch: unknown[]) => unknown })
		.getLatestTodoPhasesFromEntries;
	if (typeof read !== "function") return undefined;
	try {
		const phases = read(session.sessionManager.getBranch());
		return Array.isArray(phases) ? currentTask(phases) : undefined;
	} catch {
		return undefined;
	}
}

export const methods = guard("checkoutPeers", {
	/** `CheckoutPeers` from main; both lists empty when the session works alone. Emits `checkout_peers` when it changes. */
	[CHECKOUT_PEERS_SET]: async (params: unknown, env) => {
		if (state.set(params)) env.emit({ type: CHECKOUT_PEERS_EVENT, peers: state.peers ?? null });
		return { ok: true };
	},
	/** `{}` → `{files, stamps, task?}`: the files this session changed, each one's edit stamp, its in-progress todo item. */
	[CHECKOUT_STATUS]: async (_params: unknown, env) => {
		const task = readTask(env.session() as unknown as TaskSession);
		const files = [...ledger.files];
		return { files, stamps: files.map(file => ledger.stamp(file)), ...(task ? { task } : {}) };
	},
	/** `{files: [{file, stamp}]}` → `{ok}`: claims main saw committed; one changed again since stays. */
	[CHECKOUT_RETIRE]: async (params: unknown) => {
		ledger.retire(retiredClaims(params));
		return { ok: true };
	},
	/** `{}` → `{peers}`: what the last `checkout_peers` frame carried. */
	[CHECKOUT_PEERS_GET]: async () => ({ peers: state.peers ?? null }),
});
