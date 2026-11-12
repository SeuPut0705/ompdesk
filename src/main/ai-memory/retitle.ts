/**
 * The one-time repair of what the old prompt-first-line titling left behind (resources/gui-bridge/memory-prompt.ts): session pages
 * filed under `<ompdesk-agent-message from="…">` or "Complete assignment thoroughly:", and the open handoffs a
 * subagent or an agent-opened session left for the next session of the folder.
 *
 * The repair is the core's (`native/ompdesk/crates/core/src/upkeep/retitle.rs`): every read and write goes through
 * the server's own paths (a page is rewritten with `/admin/write-page`, a handoff is discarded with
 * `memory_handoff_cancel`), and `dryRun` reads and plans only. This file is its client.
 */

import type { AiMemoryProjectRef } from "../../shared/ai-memory";
import { core } from "../core/process";
import type { AiMemoryClient } from "./client";
import { answerAsks, collatorLocale, coreSide, serviceName } from "./core-asks";

/** The client calls the repair makes (a fake implements exactly these). */
export type RetitleClient = Pick<
	AiMemoryClient,
	"projects" | "pages" | "page" | "observations" | "writeSessionPage" | "handoffs" | "cancelHandoff"
>;

export interface RetitleItem extends AiMemoryProjectRef {
	path: string;
	from: string;
	to: string;
}

export interface RetitleReport {
	dryRun: boolean;
	projects: number;
	sessionPages: number;
	/** Session pages whose title names no task. */
	junk: number;
	/** Pages rewritten (dry run: that would be). */
	retitled: RetitleItem[];
	/** A junk page whose session has no usable prompt: left as it is. */
	unresolved: string[];
	/** Pages another writer changed between planning and writing: left for the next run. */
	changed: string[];
	/** Open handoffs in all, and those a child session left (discarded; dry run: that would be). */
	openHandoffs: number;
	childHandoffs: number;
	failed: string[];
}

/** Every project's pages are read (up to twenty pages of prompts for each junk one) and rewritten one request at a time. */
const CORE_TIMEOUT_MS = 600_000;

/** Retitle the junk session pages of every project and discard the child handoffs still open. */
export async function retitleSessionPages(client: RetitleClient, options: { dryRun: boolean }): Promise<RetitleReport> {
	const service = serviceName();
	const side = coreSide(client);
	const stop = answerAsks(service, side.handlers);
	try {
		const answer = await core().call<RetitleReport>(
			"upkeep.retitle",
			{ service, ...side.wire(), locale: collatorLocale(), dryRun: options.dryRun },
			{ timeoutMs: CORE_TIMEOUT_MS },
		);
		return answer.result;
	} finally {
		stop();
	}
}
