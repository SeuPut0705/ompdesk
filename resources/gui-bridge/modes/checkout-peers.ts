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
	CHECKOUT_PEERS_SECTION_ID,
	CHECKOUT_PEERS_SET,
	CHECKOUT_TOUCHED,
	type CheckoutPeer,
	type CheckoutPeers,
} from "./checkout-peers-contracts";
import { canonicalPath, checkoutRefusal, checkoutSection, rememberFiles } from "./checkout-peers-core";

/** Main's spelling of a path: it resolves top levels with realpath, and a session's cwd may go through a symlink. */
const real = (path: string) => fs.realpathSync.native(path);

let peers: CheckoutPeers | undefined;
let ownFiles: string[] = [];

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	registerPromptSection(pi, CHECKOUT_PEERS_SECTION_ID, () => checkoutSection(peers));
	pi.on("tool_call", (event, ctx) => {
		const written = fileToolPaths(event.toolName, event.input);
		if (written.length > 0)
			ownFiles = rememberFiles(
				ownFiles,
				written.map(file => canonicalPath(normalizePath(file, ctx.cwd), real)),
				CHECKOUT_FILES_MAX,
			);
		if (!peers || event.toolName !== "bash") return undefined;
		const input = event.input as { command?: unknown; cwd?: unknown };
		if (typeof input.command !== "string") return undefined;
		const reason = checkoutRefusal(
			input.command,
			canonicalPath(normalizePath(typeof input.cwd === "string" ? input.cwd : ".", ctx.cwd), real),
			peers,
			ownFiles,
			real,
		);
		return reason ? { block: true, reason } : undefined;
	});
}

function peerList(value: unknown): CheckoutPeer[] {
	if (!Array.isArray(value)) throw new Error(`${CHECKOUT_PEERS_SET} needs peer lists`);
	return value.flatMap(item => {
		if (typeof item !== "object" || item === null) return [];
		const peer = item as Record<string, unknown>;
		return [
			{
				id: typeof peer.id === "string" ? peer.id : null,
				title: typeof peer.title === "string" ? peer.title.slice(0, 200) : "",
				...(typeof peer.device === "string" ? { device: peer.device } : {}),
				...(typeof peer.worktree === "string" ? { worktree: normalizePath(peer.worktree, "/") } : {}),
				...(Array.isArray(peer.files)
					? {
							files: peer.files
								.filter((file): file is string => typeof file === "string")
								.slice(0, CHECKOUT_FILES_MAX)
								.map(file => normalizePath(file, "/")),
						}
					: {}),
			},
		];
	});
}

export const methods = guard("checkoutPeers", {
	/** `CheckoutPeers` from main; both lists empty when the session works alone. */
	[CHECKOUT_PEERS_SET]: async (params: unknown) => {
		const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
		if (typeof record.toplevel !== "string" || typeof record.commonDir !== "string")
			throw new Error(`${CHECKOUT_PEERS_SET} needs {toplevel, commonDir, worktree, repo, canMessage}`);
		const next: CheckoutPeers = {
			toplevel: normalizePath(record.toplevel, "/"),
			commonDir: normalizePath(record.commonDir, "/"),
			worktree: peerList(record.worktree),
			repo: peerList(record.repo),
			canMessage: record.canMessage === true,
		};
		peers = next.worktree.length > 0 || next.repo.length > 0 ? next : undefined;
		return { ok: true };
	},
	[CHECKOUT_TOUCHED]: async () => ({ files: ownFiles }),
});
