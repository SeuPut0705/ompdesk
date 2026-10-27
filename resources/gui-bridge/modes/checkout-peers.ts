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
 * - keeps those claims in the session's journal (`ompdesk.checkout-claims`) and reads them back when the session
 *   loads, so a restart or a relaunch of the omp keeps protecting work nobody committed,
 * - says once, through `tool_call`'s `additionalContext`, that a peer changed a file this session just changed, or
 *   started changing one it changed earlier.
 * One module state per omp: the main agent and its subagents share the checkout, so they share the guard.
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
import { CheckoutLedger, CheckoutPeersState, checkoutSection, currentTask, reportedFiles } from "./checkout-peers-core";
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
	exists: (path: string) => fs.existsSync(path),
	expand: (glob: string): string[] => {
		const cut = glob.search(/[*?[]/);
		const base = glob.slice(0, glob.lastIndexOf("/", cut)) || "/";
		try {
			return [
				...new Bun.Glob(glob.slice(base.length + 1)).scanSync({
					cwd: base,
					absolute: true,
					onlyFiles: true,
					dot: true,
				}),
			].map(file => file.replaceAll("\\", "/"));
		} catch {
			return [];
		}
	},
};

const state = new CheckoutPeersState();
const ledger = new CheckoutLedger();

/** The journal entry holding the session's claims: `{files, stamps, at}`, the newest one wins. */
const CLAIMS_ENTRY = "ompdesk.checkout-claims";
/** The claims are written to the journal at most this often (a burst of edits is one entry), and at the end of a run and at shutdown. */
const JOURNAL_INTERVAL_MS = 15_000;
/** The tool results that name the files they changed (an applied `ast_edit`, an lsp rename). */
const REPORTING = new Set(["ast_edit", "write", "resolve", "lsp"]);

let installs = 0;
/** The main agent's `pi`: the journal entry belongs to the session, not to a subagent's. */
let mainPi: ExtensionAPI | undefined;
let journaled = ledger.revision;
let journaledAt = 0;
let journalTimer: ReturnType<typeof setTimeout> | undefined;

function writeJournal(): void {
	clearTimeout(journalTimer);
	journalTimer = undefined;
	if (!mainPi || ledger.revision === journaled) return;
	journaled = ledger.revision;
	journaledAt = Date.now();
	try {
		mainPi.appendEntry(CLAIMS_ENTRY, { ...ledger.snapshot(), at: journaledAt });
	} catch {
		// A journal that cannot be written costs only the restart protection; the claims in memory still guard.
		journaled = -1;
	}
}

/** The claims changed: write the journal now, or once the interval since the last write has passed. */
function journalSoon(): void {
	if (!mainPi || ledger.revision === journaled || journalTimer) return;
	const wait = journaledAt + JOURNAL_INTERVAL_MS - Date.now();
	if (wait <= 0) writeJournal();
	else {
		journalTimer = setTimeout(writeJournal, wait);
		journalTimer.unref?.();
	}
}

/** The session loaded: its journal's newest claims entry becomes the ledger's (none when it has none, as after a switch to a new session). */
function restoreClaims(ctx: ExtensionContext): void {
	let data: unknown;
	try {
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if ("customType" in entry && entry.customType === CLAIMS_ENTRY && "data" in entry) {
				data = entry.data;
				break;
			}
		}
	} catch {
		// An unreadable journal restores nothing.
	}
	ledger.restore(data);
	journaled = ledger.revision;
	// Main reads the claims it can no longer see in git (committed while the omp was away) at once.
	if (ledger.files.length > 0) emit({ type: CHECKOUT_FILES_EVENT });
}

/** `details.async` of a stock bash result or update: `{state, jobId}`. */
function asyncOf(details: unknown): { state: string; jobId: string } | undefined {
	if (typeof details !== "object" || details === null || !("async" in details)) return undefined;
	const async = details.async;
	if (typeof async !== "object" || async === null || !("state" in async) || !("jobId" in async)) return undefined;
	return typeof async.state === "string" && typeof async.jobId === "string"
		? { state: async.state, jobId: async.jobId }
		: undefined;
}

/** The background jobs of this agent that ended since: their commands wrote what they were going to write. */
function reconcileJobs(ctx: ExtensionContext, owner: string): void {
	let running: Set<string> | undefined;
	try {
		const snapshot = ctx.getAsyncJobSnapshot();
		if (snapshot) running = new Set(snapshot.running.map(job => job.id));
	} catch {
		// A job list that cannot be read settles nothing.
	}
	if (running && ledger.reconcileJobs(running, owner)) emit({ type: CHECKOUT_FILES_EVENT });
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	// Each agent (the main one, each in-process subagent) gets its own `pi`: its run's end settles only its own calls.
	const owner = `agent-${++installs}`;
	registerPromptSection(pi, CHECKOUT_PEERS_SECTION_ID, () => checkoutSection(state.peers));
	if (owner === "agent-1") {
		mainPi = pi;
		for (const name of ["session_start", "session_switch"] as const) pi.on(name, (_event, ctx) => restoreClaims(ctx));
		// The omp ends (an update's restart, a quit): the last claims must not wait for the interval.
		pi.on("session_shutdown", () => writeJournal());
	}
	pi.on("tool_call", (event, ctx) => {
		reconcileJobs(ctx, owner);
		const verdict = ledger.call(event.toolName, event.input, ctx.cwd, state.peers, host, event.toolCallId, owner);
		if ("block" in verdict) return { block: true, reason: verdict.block };
		// Main learns of a new claim now, not at its next sweep, so the others' guards see the file within a pass.
		if (verdict.gained) emit({ type: CHECKOUT_FILES_EVENT });
		journalSoon();
		return verdict.notice ? { additionalContext: verdict.notice } : undefined;
	});
	// The write has landed: main reads it now. Until then the claim cannot be retired (git may not show it yet).
	pi.on("tool_result", event => {
		const details = "details" in event ? event.details : undefined;
		const async = asyncOf(details);
		const text = event.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		const settled = ledger.settle(event.toolCallId, owner, {
			isError: event.isError === true,
			// A command that went to the background has not written yet: its claims wait for the job.
			...(async?.state === "running" ? { job: async.jobId } : {}),
			reported: REPORTING.has(event.toolName) ? reportedFiles(event.toolName, details, text) : [],
		});
		if (settled) emit({ type: CHECKOUT_FILES_EVENT });
		journalSoon();
		return undefined;
	});
	// A background job reports its end through updates of the call that started it.
	pi.on("tool_execution_update", event => {
		const result = "partialResult" in event ? event.partialResult : undefined;
		const async = asyncOf(
			typeof result === "object" && result !== null && "details" in result ? result.details : undefined,
		);
		if (async && async.state !== "running" && ledger.settleJob(async.jobId)) emit({ type: CHECKOUT_FILES_EVENT });
	});
	// A call stock refused after the hook (a denied approval) never reports back; this agent's run end settles it.
	pi.on("agent_end", (_event, ctx) => {
		const settled = ledger.settleAll(owner);
		reconcileJobs(ctx, owner);
		if (settled) emit({ type: CHECKOUT_FILES_EVENT });
		// The run is over: the journal keeps what the session holds now.
		writeJournal();
	});
}

/** The in-progress todo item of the session's branch; none when stock's reader is missing or throws. */
async function readTask(session: { sessionManager: { getBranch(): unknown[] } }): Promise<string | undefined> {
	try {
		// Late and literal on purpose (health.ts LOADERS): an omp without this reader must not take the guard down at link time.
		const { getLatestTodoPhasesFromEntries: read } = await import("@oh-my-pi/pi-coding-agent/tools/todo");
		if (typeof read !== "function") return undefined;
		const phases = read(session.sessionManager.getBranch() as Parameters<typeof read>[0]);
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
	/** `{}` → `CheckoutStatus`: the files this session changed with their edit stamps, the paths still being written, this load's instance, its in-progress todo item. */
	[CHECKOUT_STATUS]: async (_params: unknown, env) => {
		let session: AgentSession | undefined;
		try {
			session = env.session();
		} catch {
			// No live session yet: the claims in memory answer alone.
		}
		// A job that ended while no hook ran (a command finishing in an idle session) is settled by what main asks.
		const jobs = session?.getAsyncJobTree?.();
		if (jobs && ledger.reconcileJobs(new Set(jobs.running.map(job => job.id))))
			env.emit({ type: CHECKOUT_FILES_EVENT });
		const task = session ? await readTask(session) : undefined;
		return { ...ledger.status(), ...(task ? { task } : {}) };
	},
	/** `{instance, files: [{file, stamp}]}` → `{ok}`: claims main saw committed; one changed again since stays; another load's stamps mean nothing. */
	[CHECKOUT_RETIRE]: async (params: unknown) => {
		ledger.retireFrom(params);
		journalSoon();
		return { ok: true };
	},
	/** `{}` → `{peers}`: what the last `checkout_peers` frame carried. */
	[CHECKOUT_PEERS_GET]: async () => ({ peers: state.peers ?? null }),
});
