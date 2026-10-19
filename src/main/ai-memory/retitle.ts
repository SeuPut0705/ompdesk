/**
 * The one-time repair of what the old prompt-first-line titling left behind (src/shared/memory-prompt.ts): session pages
 * filed under `<ompdesk-agent-message from="…">` or "Complete assignment thoroughly:", and the open handoffs a
 * subagent or an agent-opened session left for the next session of the folder.
 *
 * Everything goes through the server's own paths, never its files: a page is rewritten with `/admin/write-page`
 * (a new version; the old one stays in history and the write names its checkpoint), a handoff is discarded with
 * `memory_handoff_cancel`. `dryRun` reads and plans only. The new title is the one the extension now sends for the
 * same prompt (`promptTitle`), read from the session's first prompt; a page whose session has no usable prompt is left
 * as it is and counted.
 */
import type { AiMemoryHandoff, AiMemoryPage, AiMemoryProjectRef } from "../../shared/ai-memory";
import { isAgentPrompt, isJunkTitle, promptTitle } from "../../shared/memory-prompt";
import type { AiMemoryClient } from "./client";

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

const SESSION_PREFIX = "sessions/";
/** Prompts come 50 to a page; a session of a thousand prompts is not a session this repair needs to finish naming. */
const MAX_OBSERVATION_PAGES = 20;
const PROMPTS_ONLY = ["user-prompt"] as const;
/** The handoff summary's lead-in (`build_auto_handoff`): "Started: …" while the session ran, "Session focused on: …" after. */
const HANDOFF_LEAD = /^(?:Started|Session focused on):\s*/;

/** A handoff a child session left: its summary's subject is an agent-written prompt. */
export function isChildHandoff(handoff: Pick<AiMemoryHandoff, "summary" | "state">): boolean {
	if (handoff.state !== "open") return false;
	const lead = HANDOFF_LEAD.exec(handoff.summary);
	return lead !== null && isAgentPrompt(handoff.summary.slice(lead[0].length));
}

const titleKey = (title: string): string => title.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** `sessions/<id>.md` → the session id. */
const sessionIdOf = (path: string): string => path.slice(SESSION_PREFIX.length).replace(/\.md$/, "");

/** What the session's prompts are called now, by the title the page used to carry for each. */
interface SessionTitles {
	/** The first prompt that has a task to name: the page's new title. */
	first: string | null;
	/** Old observation title → new title, for the lines of the page that list the prompts. */
	renames: Map<string, string>;
}

async function sessionTitles(
	client: RetitleClient,
	project: AiMemoryProjectRef,
	sessionId: string,
): Promise<SessionTitles> {
	const titles: SessionTitles = { first: null, renames: new Map() };
	let offset = 0;
	for (let pageNo = 0; pageNo < MAX_OBSERVATION_PAGES; pageNo++) {
		const { observations, total } = await client.observations(project, sessionId, offset, PROMPTS_ONLY);
		for (const observation of observations) {
			const title = promptTitle(observation.body);
			if (!title) continue;
			titles.first ??= title;
			if (observation.title && observation.title !== title) titles.renames.set(observation.title, title);
		}
		offset += observations.length;
		if (observations.length === 0 || offset >= total) break;
	}
	return titles;
}

/** The new title of a line that shows an old one, cut at the end the way the page cuts a long title. */
function renamed(text: string, renames: ReadonlyMap<string, string>): string | undefined {
	const exact = renames.get(text);
	if (exact) return exact;
	const cut = text.endsWith("…") ? text.slice(0, -1) : null;
	if (!cut) return undefined;
	const matches = [...renames].filter(([old]) => old.startsWith(cut));
	return matches.length === 1 ? matches[0]?.[1] : undefined;
}

/**
 * The page's markdown with `from` replaced by `to` where the page printed it: the leading `# heading`, and the prompt
 * lists (`## Prompts`, the `user-prompt` lines of `## Raw observations`) for every prompt whose title changed.
 */
export function retitleMarkdown(
	markdown: string,
	from: string,
	to: string,
	renames: ReadonlyMap<string, string>,
): string {
	const lines = markdown.split("\n");
	let section = "";
	let headed = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			continue;
		}
		if (!headed && line.trim() !== "") {
			headed = true;
			if (line === `# ${from}`) lines[index] = `# ${to}`;
			continue;
		}
		if (section === "Prompts") {
			const item = /^(\d+\. )(.*)$/.exec(line);
			const next = item ? renamed(item[2] ?? "", renames) : undefined;
			if (item && next) lines[index] = `${item[1]}${next}`;
		} else if (section === "Raw observations") {
			const item = /^(- `user-prompt` @ \S+ — )(.*)$/.exec(line);
			const next = item ? renamed(item[2] ?? "", renames) : undefined;
			if (item && next) lines[index] = `${item[1]}${next}`;
		}
	}
	return lines.join("\n");
}

async function retitleProject(
	client: RetitleClient,
	project: AiMemoryProjectRef,
	dryRun: boolean,
	report: RetitleReport,
): Promise<void> {
	const pages = await client.pages(project);
	const sessions = pages
		.filter(page => page.path.startsWith(SESSION_PREFIX))
		.sort((a, b) => a.path.localeCompare(b.path));
	report.sessionPages += sessions.length;
	const taken = new Set(pages.filter(page => !isJunkTitle(page.title)).map(page => titleKey(page.title)));
	for (const ref of sessions.filter(page => isJunkTitle(page.title))) {
		report.junk += 1;
		try {
			const titles = await sessionTitles(client, project, sessionIdOf(ref.path));
			if (!titles.first) {
				report.unresolved.push(ref.path);
				continue;
			}
			// Two sessions of one task title alike: the later ones carry their short id, as the server's own rule does.
			const to = taken.has(titleKey(titles.first))
				? `${titles.first} (session ${sessionIdOf(ref.path).slice(0, 8)})`
				: titles.first;
			taken.add(titleKey(to));
			const page: AiMemoryPage = await client.page({ ...project, path: ref.path });
			if (!dryRun) {
				try {
					await client.writeSessionPage({
						...project,
						path: ref.path,
						sessionId: sessionIdOf(ref.path),
						body: retitleMarkdown(page.markdown, page.title, to, titles.renames),
						expectedPageId: page.id,
						tier: page.tier ?? "episodic",
						...(page.summary ? { abstract: page.summary } : {}),
					});
				} catch (error) {
					// A SessionEnd rewrote the page since it was read: its own title stands until the next run.
					if (!(error instanceof Error) || !/precondition/i.test(error.message)) throw error;
					report.changed.push(ref.path);
					continue;
				}
			}
			report.retitled.push({ ...project, path: ref.path, from: page.title, to });
		} catch (error) {
			report.failed.push(`${ref.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const handoffs = await client.handoffs(project);
	const open = handoffs.filter(handoff => handoff.state === "open");
	report.openHandoffs += open.length;
	for (const handoff of open.filter(isChildHandoff)) {
		report.childHandoffs += 1;
		if (dryRun) continue;
		await client.cancelHandoff(project, handoff.id).catch((error: unknown) => {
			report.failed.push(`handoff ${handoff.id}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
}

/** Retitle the junk session pages of every project and discard the child handoffs still open. */
export async function retitleSessionPages(client: RetitleClient, options: { dryRun: boolean }): Promise<RetitleReport> {
	const report: RetitleReport = {
		dryRun: options.dryRun,
		projects: 0,
		sessionPages: 0,
		junk: 0,
		retitled: [],
		unresolved: [],
		changed: [],
		openHandoffs: 0,
		childHandoffs: 0,
		failed: [],
	};
	for (const project of await client.projects()) {
		report.projects += 1;
		await retitleProject(
			client,
			{ workspace: project.workspace, project: project.project },
			options.dryRun,
			report,
		).catch((error: unknown) => {
			report.failed.push(
				`${project.workspace}/${project.project}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
	return report;
}
