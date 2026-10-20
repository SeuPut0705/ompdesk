/**
 * Sessions sharing a checkout (rules: checkout-peers-core.ts, contracts: checkout-peers-contracts.ts). Main knows
 * which live sessions of this computer work in the same worktree or repository and pushes them here
 * (`checkout_peers_set`); this module then
 * - adds the `<shared-checkout>` section to every prompt (names and ids, so the agent can reach the others),
 * - refuses through stock's `tool_call` hook a git command that would take, overwrite or hide their work,
 * - remembers the files this session's agents wrote (file tools), which main reads (`checkout_touched`) to tell the
 *   others which files are this session's.
 * One module state per omp: the main agent and its subagents share the checkout, so they share the guard.
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { fileToolPaths, normalizePath } from "./autopilot-guard-core";
import {
	CHECKOUT_FILES_MAX,
	CHECKOUT_PEERS_EVENT,
	CHECKOUT_PEERS_GET,
	CHECKOUT_PEERS_SECTION_ID,
	CHECKOUT_PEERS_SET,
	CHECKOUT_TOUCHED,
} from "./checkout-peers-contracts";
import {
	CheckoutPeersState,
	canonicalPath,
	checkoutRefusal,
	checkoutSection,
	rememberFiles,
	shellWrites,
	writeRefusal,
} from "./checkout-peers-core";

/** Main's spelling of a path: it resolves top levels with realpath, and a session's cwd may go through a symlink. */
const real = (path: string) => fs.realpathSync.native(path);

const state = new CheckoutPeersState();
let ownFiles: string[] = [];

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, CHECKOUT_PEERS_SECTION_ID, () => checkoutSection(state.peers));
	pi.on("tool_call", (event, ctx) => {
		const written = fileToolPaths(event.toolName, event.input).map(file =>
			canonicalPath(normalizePath(file, ctx.cwd), real),
		);
		const peers = state.peers;
		if (peers && event.toolName === "write") {
			const reason = writeRefusal(written, peers, ownFiles);
			if (reason) return { block: true, reason };
		}
		if (written.length > 0) ownFiles = rememberFiles(ownFiles, written, CHECKOUT_FILES_MAX);
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { command?: unknown; cwd?: unknown };
		if (typeof input.command !== "string") return undefined;
		const cwd = canonicalPath(normalizePath(typeof input.cwd === "string" ? input.cwd : ".", ctx.cwd), real);
		const reason = peers ? checkoutRefusal(input.command, cwd, peers, ownFiles, real) : undefined;
		if (reason) return { block: true, reason };
		// A file written from the shell is this session's too, alone or not, so a session that joins later sees it.
		const shellWritten = shellWrites(input.command, cwd, real);
		if (shellWritten.length > 0) ownFiles = rememberFiles(ownFiles, shellWritten, CHECKOUT_FILES_MAX);
		return undefined;
	});
}

export const methods = guard("checkoutPeers", {
	/** `CheckoutPeers` from main; both lists empty when the session works alone. Emits `checkout_peers` when it changes. */
	[CHECKOUT_PEERS_SET]: async (params: unknown, env) => {
		if (state.set(params)) env.emit({ type: CHECKOUT_PEERS_EVENT, peers: state.peers ?? null });
		return { ok: true };
	},
	[CHECKOUT_TOUCHED]: async () => ({ files: ownFiles }),
	/** `{}` → `{peers}`: what the last `checkout_peers` frame carried. */
	[CHECKOUT_PEERS_GET]: async () => ({ peers: state.peers ?? null }),
});
