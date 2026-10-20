/**
 * Session conclusions for the turns that ended before the server captured them (it keeps a turn's last reply only from
 * 19 Oct 2026 21:49 UTC on), read back from omp's own journals: each assistant message that ended a run
 * (`stopReason: "stop"`) with text is a conclusion, cut by the shipped `conclusionExcerpt` (the diagnostics redaction and the
 * 2000-byte cut live capture uses). Measured on the 188 native conclusions of the user's store (20 Oct 2026): 184
 * of them equal such a message by their first 60 characters, and 14 more such messages were never kept by the server.
 * A run does not end "at the next user message": 135 of the 166 native conclusions found in a journal are followed
 * by a custom message (goal-mode context, mail, recap), only 17 by a user prompt.
 *
 * Only the server's one write path is used: `writeConclusions` into the project the server already holds the session
 * under (its id), else the one project every known session of the journal's folder belongs to; any other journal is
 * skipped and counted. The rows are written as copies from THIS computer (`origin` = its device id), which is what
 * lets sync.ts carry them to the paired computers exactly once: the other computer stores them under this device, never
 * offers them back (`origin === peer`), and this computer's own pull drops them (`origin === self`). A constant origin
 * such as "backfill" would be offered back by the host and answered `same` on every round. The id says what they are:
 * `backfill:<session id>:<message time in ms>`, stable, so a second pass (or a second computer with the same journal) writes
 * nothing new.
 *
 * A turn the server captured itself is never copied: per session only the turns before its first native conclusion
 * (the global start of capture for a session with none; with no native conclusion at all, ten minutes ago, so a turn
 * whose Stop is still on its way is not doubled), and never one whose text equals a native conclusion of that session.
 *
 * State (`memo.backfill`) records the journals a pass finished, keyed by the database id the server reports (a new store
 * starts over). A pass reads at most `maxJournals` journals and writes at most `maxRows` rows and goes on from the state.
 */

import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import {
	conclusionExcerpt,
	explicitTitle,
	firstMeaningfulLine,
	isAgentPrompt,
	isJunkTitle,
	promptTitle,
} from "../../../resources/gui-bridge/memory-prompt";
import type { AiMemoryProjectRef } from "../../shared/ai-memory";
import type { AiMemoryClient } from "./client";
/** The client calls a pass makes (a fake implements exactly these). */
export type BackfillClient = Pick<
	AiMemoryClient,
	"projects" | "sessions" | "pages" | "conclusions" | "writeConclusions"
>;

export interface BackfillDeps {
	client: BackfillClient;
	/** The stock sessions folder: `<cwd-slug>/<timestamp>_<id>.jsonl`, a subagent's at `<…>/<timestamp>_<id>/<n>-<Agent>.jsonl`. */
	sessionsDir: string;
	/** The messages along a journal's persisted leaf (`SessionIndex.readMessages`, stock `loadSessionMessagesReadOnly`). */
	readMessages(path: string): Promise<readonly unknown[]>;
	/** This computer's OMPdesk device id (sync.ts `selfId()`): the origin the copies are written under. */
	origin: string;
	/**
	 * Plain-JSON state the caller keeps between launches (care.json): the journals a pass finished, under the key
	 * `backfill`. The pass mutates it in place; the caller persists it after the pass, whatever the outcome.
	 */
	memo: Record<string, unknown>;
	/** The one runtime-log line of a pass that read a journal: `care-backfill`. */
	log(message: string, details: Record<string, string | number | boolean | null>): void;
	now?(): number;
	maxJournals?: number;
	maxRows?: number;
}

export interface BackfillReport {
	/** The database the state belongs to ("" from a server that does not say). */
	store: string;
	/** Conversation journals found (an advisor's `__advisor.jsonl` never counts). */
	journals: number;
	/** Finished in an earlier pass and unchanged since: not looked at. */
	done: number;
	/** Looked at this pass and mapped to a project, by the session id the server holds / by the folder. */
	mappedById: number;
	mappedByCwd: number;
	/** Skipped: no session header, the folder none of the server's sessions use, the folder two projects' sessions use. */
	noHeader: number;
	unmapped: number;
	ambiguous: number;
	/** A mapped journal stock could not read. */
	unreadable: number;
	/**
	 * Read but not copied: an agent wrote the first prompt (a subagent's assignment, another session's message) and it
	 * names no task with a `Title:` line. Such briefs ("Read history://X §1", "Continue Shell3's work") are the
	 * orchestration's own plumbing; their replies were most of what recall injected wrongly.
	 */
	untitled: number;
	/** Journals read this pass, and the turns of them still to be written (not native, before the cutoff). */
	read: number;
	turns: number;
	written: number;
	same: number;
	/** Rows the server kept nothing of after its own scrubbing. */
	refused: number;
	/** Mapped journals still waiting for a later pass (the budget ended this one). */
	remaining: number;
	/** The server failed a write: the pass stopped, the journal is read again next time. */
	failed: boolean;
	ms: number;
}

const State = z.object({ v: z.literal(1), store: z.string(), done: z.record(z.number()) });
type State = z.infer<typeof State>;

/** A journal whose eligible turns can no longer change: the cutoff came from the server's own conclusions. */
const FINAL = -1;
const MAX_JOURNALS = 300;
const MAX_ROWS = 1500;
const WRITE_BATCH = 200;
const NATIVE_PAGE = 500;
const MAX_NATIVE_PAGES = 400;
const SESSION_PAGE = 100;
const MAX_SESSION_PAGES = 100;
/** With no native conclusion in the store at all: a turn this recent may still be about to get its own. */
const RECENT_MS = 10 * 60_000;
const HEADER_BYTES = 32 * 1024;
const MEMO_KEY = "backfill";
const ADVISOR_JOURNAL = "__advisor.jsonl";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAME_TEXT_CHARS = 60;

const projectKey = (ref: AiMemoryProjectRef): string => `${ref.workspace}\u0000${ref.project}`;
const sessionKey = (id: string): string => id.replaceAll("-", "").toLowerCase();
const textKey = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, SAME_TEXT_CHARS);

/** Every conversation journal under `dir`, oldest name first. */
async function journalsUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (folder: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== ADVISOR_JOURNAL) found.push(path);
		}
	};
	await walk(dir);
	return found.sort();
}

interface Header {
	id: string;
	cwd: string | null;
	title: string | null;
}

/** The journal's `type: "session"` line (stock writes it first or just after a title line). */
async function readHeader(path: string): Promise<Header | null> {
	const file = await open(path, "r").catch(() => null);
	if (!file) return null;
	try {
		const buffer = Buffer.alloc(HEADER_BYTES);
		const { bytesRead } = await file.read(buffer, 0, HEADER_BYTES, 0);
		for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 8)) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const row = entry as { type?: unknown; id?: unknown; cwd?: unknown; title?: unknown } | null;
			if (row?.type !== "session") continue;
			if (typeof row.id !== "string" || !UUID.test(row.id)) return null;
			return {
				id: row.id.toLowerCase(),
				cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null,
				title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
			};
		}
		return null;
	} finally {
		await file.close();
	}
}

interface Turn {
	at: number;
	body: string;
}

interface Message {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
	timestamp?: unknown;
}

/** A run's final reply: an assistant message that stopped (not for a tool call) and said something in words. */
function turnsOf(messages: readonly unknown[]): Turn[] {
	const turns: Turn[] = [];
	for (const raw of messages) {
		const message = raw as Message | null;
		if (message?.role !== "assistant" || message.stopReason !== "stop") continue;
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) continue;
		const body = conclusionExcerpt([message]);
		if (body) turns.push({ at: message.timestamp, body });
	}
	return turns;
}

function firstPrompt(messages: readonly unknown[]): string | undefined {
	for (const raw of messages) {
		const message = raw as Message | null;
		if (message?.role !== "user") continue;
		const parts: unknown[] =
			typeof message.content === "string"
				? [message.content]
				: Array.isArray(message.content)
					? message.content
					: [];
		const text = parts
			.map(part => {
				if (typeof part === "string") return part;
				const isText = part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part;
				return isText ? String(part.text) : "";
			})
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

/** What the server knows of its own conclusions: where its capture began and what it already holds per session. */
interface Natives {
	store: string;
	/** The earliest native conclusion in the store, ms; null when it has none. */
	first: number | null;
	firstBySession: Map<string, number>;
	textsBySession: Map<string, Set<string>>;
	/** session → project, from the rows themselves. */
	projectBySession: Map<string, AiMemoryProjectRef>;
}

async function readNatives(client: BackfillClient): Promise<Natives> {
	const natives: Natives = {
		store: "",
		first: null,
		firstBySession: new Map(),
		textsBySession: new Map(),
		projectBySession: new Map(),
	};
	let after = 0;
	for (let page = 0; page < MAX_NATIVE_PAGES; page++) {
		const batch = await client.conclusions("native", after, NATIVE_PAGE);
		natives.store = batch.store;
		for (const row of batch.rows) {
			const key = sessionKey(row.sessionId);
			const at = Date.parse(row.at);
			if (Number.isFinite(at)) {
				natives.first = natives.first === null ? at : Math.min(natives.first, at);
				natives.firstBySession.set(key, Math.min(natives.firstBySession.get(key) ?? at, at));
			}
			const texts = natives.textsBySession.get(key) ?? new Set<string>();
			texts.add(textKey(row.body));
			natives.textsBySession.set(key, texts);
			natives.projectBySession.set(key, { workspace: row.workspace, project: row.project });
		}
		if (!batch.more || batch.next === after) break;
		after = batch.next;
	}
	return natives;
}

/** The sessions the server holds: the project of each id, and the projects whose sessions ran in each folder. */
async function readSessions(client: BackfillClient): Promise<{
	projectById: Map<string, AiMemoryProjectRef>;
	projectsByCwd: Map<string, Map<string, AiMemoryProjectRef>>;
}> {
	const projectById = new Map<string, AiMemoryProjectRef>();
	const projectsByCwd = new Map<string, Map<string, AiMemoryProjectRef>>();
	for (const listed of await client.projects()) {
		const project = { workspace: listed.workspace, project: listed.project };
		for (let page = 0; page < MAX_SESSION_PAGES; page++) {
			const sessions = await client.sessions(project, SESSION_PAGE, page * SESSION_PAGE);
			for (const session of sessions) {
				projectById.set(sessionKey(session.id), project);
				if (!session.cwd) continue;
				const projects = projectsByCwd.get(session.cwd) ?? new Map<string, AiMemoryProjectRef>();
				projects.set(projectKey(project), project);
				projectsByCwd.set(session.cwd, projects);
			}
			if (sessions.length < SESSION_PAGE) break;
		}
	}
	return { projectById, projectsByCwd };
}

interface Candidate {
	path: string;
	key: string;
	size: number;
	header: Header;
	project: AiMemoryProjectRef;
}

/**
 * One pass: map the journals not finished yet, read the server's own conclusions, and write the missing turns of as
 * many journals as the budget allows. Throws only when the server cannot be asked at all; a failed write ends the pass
 * with `failed: true`.
 */
export async function backfillConclusions(deps: BackfillDeps): Promise<BackfillReport> {
	const now = deps.now ?? Date.now;
	const started = now();
	const maxJournals = deps.maxJournals ?? MAX_JOURNALS;
	const maxRows = deps.maxRows ?? MAX_ROWS;
	const { client } = deps;
	const report: BackfillReport = {
		store: "",
		journals: 0,
		done: 0,
		mappedById: 0,
		mappedByCwd: 0,
		noHeader: 0,
		unmapped: 0,
		ambiguous: 0,
		unreadable: 0,
		untitled: 0,
		read: 0,
		turns: 0,
		written: 0,
		same: 0,
		refused: 0,
		remaining: 0,
		failed: false,
		ms: 0,
	};
	report.store = (await client.conclusions("native", 0, 1)).store;
	const saved = State.safeParse(deps.memo[MEMO_KEY]);
	const state: State =
		saved.success && saved.data.store === report.store ? saved.data : { v: 1, store: report.store, done: {} };
	deps.memo[MEMO_KEY] = state;

	const paths = await journalsUnder(deps.sessionsDir);
	report.journals = paths.length;
	const todo: { path: string; key: string; size: number }[] = [];
	for (const path of paths) {
		const key = relative(deps.sessionsDir, path);
		const size = (await stat(path).catch(() => null))?.size;
		if (size === undefined) continue;
		const finished = state.done[key];
		if (finished === FINAL || finished === size) report.done++;
		else todo.push({ path, key, size });
	}
	if (todo.length === 0) return finish(report, started, now);

	const sessions = await readSessions(client);
	const candidates: Candidate[] = [];
	for (const item of todo) {
		const header = await readHeader(item.path);
		if (!header) {
			report.noHeader++;
			continue;
		}
		const byId = sessions.projectById.get(sessionKey(header.id));
		if (byId) {
			report.mappedById++;
			candidates.push({ ...item, header, project: byId });
			continue;
		}
		const projects = header.cwd ? sessions.projectsByCwd.get(header.cwd) : undefined;
		if (!projects) report.unmapped++;
		else if (projects.size > 1) report.ambiguous++;
		else {
			report.mappedByCwd++;
			candidates.push({ ...item, header, project: [...projects.values()][0] as AiMemoryProjectRef });
		}
	}
	if (candidates.length === 0) return finish(report, started, now);

	const natives = await readNatives(client);
	const cutoff = natives.first ?? started - RECENT_MS;
	const titles = new Map<string, Map<string, string>>();
	const titleOf = async (project: AiMemoryProjectRef, sessionId: string): Promise<string | undefined> => {
		let byPath = titles.get(projectKey(project));
		if (!byPath) {
			byPath = new Map();
			for (const page of await client.pages(project)) byPath.set(page.path, page.title);
			titles.set(projectKey(project), byPath);
		}
		const title = byPath.get(`sessions/${sessionId}.md`);
		return title && !isJunkTitle(title) ? title : undefined;
	};

	let attempted = 0;
	for (const [index, candidate] of candidates.entries()) {
		if (report.read >= maxJournals || attempted >= maxRows) {
			report.remaining = candidates.length - index;
			break;
		}
		report.read++;
		let messages: readonly unknown[];
		try {
			messages = await deps.readMessages(candidate.path);
		} catch {
			report.unreadable++;
			state.done[candidate.key] = candidate.size;
			continue;
		}
		const first = firstPrompt(messages) ?? "";
		if (isAgentPrompt(first) && !explicitTitle(first)) {
			report.untitled++;
			state.done[candidate.key] = FINAL;
			continue;
		}
		const sessionId = sessionKey(candidate.header.id);
		const limit = natives.firstBySession.get(sessionId) ?? cutoff;
		const held = natives.textsBySession.get(sessionId);
		const turns = turnsOf(messages).filter(turn => turn.at < limit && !held?.has(textKey(turn.body)));
		report.turns += turns.length;
		if (turns.length > 0) {
			const title =
				(await titleOf(candidate.project, candidate.header.id)) ??
				promptTitle(first, { sessionName: candidate.header.title ?? undefined }) ??
				firstMeaningfulLine(turns[0]?.body ?? "") ??
				`Session ${candidate.header.id}`;
			const items = turns.map(turn => ({
				id: `backfill:${candidate.header.id}:${Math.round(turn.at)}`,
				sessionId: candidate.header.id,
				title,
				body: turn.body,
				at: new Date(turn.at).toISOString(),
			}));
			attempted += items.length;
			try {
				for (let from = 0; from < items.length; from += WRITE_BATCH) {
					const statuses = await client.writeConclusions(
						candidate.project,
						deps.origin,
						items.slice(from, from + WRITE_BATCH),
					);
					for (const status of statuses) {
						if (status === "written") report.written++;
						else if (status === "same") report.same++;
						else report.refused++;
					}
				}
			} catch {
				report.failed = true;
				report.remaining = candidates.length - index;
				break;
			}
		}
		state.done[candidate.key] = natives.first === null ? candidate.size : FINAL;
	}
	const ended = finish(report, started, now);
	deps.log("care-backfill", {
		store: ended.store,
		journals: ended.journals,
		done: ended.done,
		read: ended.read,
		mappedById: ended.mappedById,
		mappedByCwd: ended.mappedByCwd,
		noHeader: ended.noHeader,
		unmapped: ended.unmapped,
		ambiguous: ended.ambiguous,
		unreadable: ended.unreadable,
		untitled: ended.untitled,
		turns: ended.turns,
		written: ended.written,
		same: ended.same,
		refused: ended.refused,
		remaining: ended.remaining,
		failed: ended.failed,
		ms: ended.ms,
	});
	return ended;
}

function finish(report: BackfillReport, started: number, now: () => number): BackfillReport {
	report.ms = now() - started;
	return report;
}
