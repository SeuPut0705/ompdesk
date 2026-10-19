import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-control";
import type { AiMemoryObservation, AiMemorySession } from "../../shared/ai-memory";
import type { DistillMessage } from "./distill";
import type { ModelResult } from "./distill-model";
import {
	MemoryUpkeep,
	UPKEEP_DAILY_MAX,
	UPKEEP_IDLE_MS,
	UPKEEP_MIN_GAP_MS,
	type UpkeepClient,
	type UpkeepLogDetails,
} from "./upkeep";

const PROJECT = { workspace: "default", project: "ompdesk" };
const T0 = Date.parse("2026-10-19T12:00:00Z");

interface FakeSession {
	id: string;
	prompts: { text: string; at: number }[];
	startedAt?: string;
}

const session = (id: string, observations: number, startedAt = "2026-10-19T09:00:00Z"): AiMemorySession => ({
	id,
	cwd: "/work",
	agent: "omp",
	startedAt,
	endedAt: null,
	observations,
	consolidation: null,
});

/** `count` messages a person typed, the last one `quietMs` before T0. */
function typed(count: number, quietMs: number): { text: string; at: number }[] {
	return Array.from({ length: count }, (_, index) => ({
		text: `사용자 메시지 ${index + 1}`,
		at: T0 - quietMs - (count - 1 - index) * 60_000,
	}));
}

interface FakePage {
	path: string;
	title: string;
	/** Default `ompdesk`. */
	project?: string;
	body?: string;
	pinned?: boolean;
}

function fakeClient(sessions: FakeSession[], existing: FakePage[] = []) {
	const created: { project: string; path: string; body: string; tier: string; kind: string; sessionId?: string }[] =
		[];
	const taken = new Set(existing.map(page => `${page.project ?? PROJECT.project}/${page.path}`));
	const observationCalls: string[] = [];
	const retired: { project: string; path: string; successor: string; at: string }[] = [];
	const find = (project: string, path: string) =>
		existing.find(page => (page.project ?? PROJECT.project) === project && page.path === path);
	const client: UpkeepClient = {
		projects: async () => [
			{ ...PROJECT, pages: 0, lastUpdated: null },
			{ workspace: "default", project: "_global", pages: 0, lastUpdated: null },
		],
		sessions: async (_project, _limit) =>
			sessions.map(entry => session(entry.id, entry.prompts.length * 3, entry.startedAt)),
		observations: async (_project, sessionId, offset = 0, kinds) => {
			observationCalls.push(`${sessionId}:${kinds?.join(",")}`);
			const found = sessions.find(entry => entry.id === sessionId);
			const all: AiMemoryObservation[] = (found?.prompts ?? []).map((prompt, index) => ({
				id: `o${index}`,
				kind: "user-prompt",
				title: prompt.text.slice(0, 20),
				body: prompt.text,
				createdAt: new Date(prompt.at).toISOString(),
			}));
			const slice = all.slice(offset, offset + 50);
			return { session: session(sessionId, all.length), observations: slice, total: all.length, offset };
		},
		pages: async ref => [
			...existing
				.filter(page => (page.project ?? PROJECT.project) === ref.project)
				.map(page => ({
					...ref,
					path: page.path,
					title: page.title,
					kind: "note",
					tier: "semantic",
					updatedAt: null,
				})),
			...(ref.project === PROJECT.project ? sessions : []).map(entry => ({
				...PROJECT,
				path: `sessions/${entry.id}.md`,
				title: `작업 ${entry.id}`,
				kind: "session",
				tier: "episodic",
				updatedAt: null,
			})),
		],
		page: async ref => {
			const found = find(ref.project, ref.path);
			if (!found?.body) throw new Error("not read");
			return {
				...ref,
				title: found.title,
				updatedAt: null,
				tier: "semantic",
				markdown: found.body,
				id: `pg-${found.path}`,
				pinned: found.pinned === true,
				createdAt: null,
				tags: [],
			};
		},
		writeSessionPage: async () => undefined,
		handoffs: async () => [],
		cancelHandoff: async () => undefined,
		createPage: async input => {
			const key = `${input.project}/${input.path}`;
			if (taken.has(key)) return false;
			taken.add(key);
			created.push({
				project: input.project,
				path: input.path,
				body: input.body,
				tier: input.tier,
				kind: input.kind,
				...(input.sessionId ? { sessionId: input.sessionId } : {}),
			});
			return true;
		},
		retirePage: async input => {
			if (find(input.project, input.path)?.pinned) return "pinned";
			retired.push({
				project: input.project,
				path: input.path,
				successor: input.successor,
				at: input.at.toISOString(),
			});
			return "retired";
		},
	};
	return { client, created, observationCalls, retired };
}

const answer = (pages: unknown[]): ModelResult => ({
	text: JSON.stringify({ pages }),
	model: "claude-sonnet-5-5",
	inputTokens: 3500,
	outputTokens: 300,
	costUsd: 0.0162,
});
const rule = {
	kind: "rule",
	title: "동시 세션 수 제한을 두지 않는다",
	body: "동시 세션 개수에 어떤 제한도 두지 않는다.\n소유자가 여러 번 제거하라고 요구했다.",
	confidence: 0.85,
	evidence: [2, 3],
};

let dir = "";
let now = T0;
const logs: { message: string; details: UpkeepLogDetails }[] = [];
const messages: DistillMessage[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "upkeep-"));
	now = T0;
	logs.length = 0;
	messages.length = 0;
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function upkeep(
	client: UpkeepClient,
	options: {
		learn?: () => boolean;
		model?: (message: DistillMessage) => Promise<ModelResult>;
		rules?: (cwd: string) => Promise<string>;
	} = {},
) {
	return new MemoryUpkeep({
		client,
		learn: options.learn ?? (() => true),
		model:
			options.model ??
			(async message => {
				messages.push(message);
				return answer([rule]);
			}),
		stateFile: join(dir, "upkeep.json"),
		log: (message, details) => logs.push({ message, details }),
		now: () => now,
		rules: options.rules ?? (async () => ""),
	});
}

describe("MemoryUpkeep.tick", () => {
	it("reads a paused conversation of a person once and creates the pages that pass the checks", async () => {
		const { client, created } = fakeClient([
			{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 60_000) },
			{ id: "child-1", prompts: [], startedAt: "2026-10-19T11:50:00Z" },
		]);
		const outcome = await upkeep(client).tick();
		expect(outcome).toMatchObject({
			ran: true,
			session: "main-1",
			prompts: 8,
			created: ["_rules/동시-세션-수-제한을-두지-않는다.md"],
			duplicates: 0,
			refused: [],
			costUsd: 0.0162,
		});
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ tier: "semantic", kind: "rule", sessionId: "main-1" });
		expect(created[0]?.body.startsWith("# 동시 세션 수 제한을 두지 않는다\n")).toBe(true);
		// The model saw the owner's words and the titles of the work started meanwhile; not an agent's.
		expect(messages[0]?.user).toContain("[8] 사용자 메시지 8");
		expect(messages[0]?.user).toContain("- 작업 child-1");
		expect(logs).toEqual([
			{
				message: "learn",
				details: expect.objectContaining({
					session: "main-1",
					project: "default/ompdesk",
					prompts: 8,
					created: 1,
					costUsd: 0.0162,
					inputTokens: 3500,
				}),
			},
		]);
	});

	it("files the owner's preferences in _global/preferences/ for every project, shown what is already there", async () => {
		const { client, created } = fakeClient(
			[{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }],
			[{ project: "_global", path: "preferences/한-줄-행.md", title: "설정 행은 한 줄로" }],
		);
		const preference = {
			kind: "preference",
			title: "보고는 결론부터 쓴다",
			body: "보고할 때 결론을 첫 줄에 쓰고 근거를 뒤에 둔다.\n소유자가 여러 번 요구했다.",
			quote: "사용자 메시지 3",
			confidence: 0.8,
			evidence: [3],
		};
		const worker = upkeep(client, {
			model: async message => {
				messages.push(message);
				return answer([rule, preference]);
			},
		});
		expect(await worker.tick()).toMatchObject({
			ran: true,
			created: ["_rules/동시-세션-수-제한을-두지-않는다.md", "_global/preferences/보고는-결론부터-쓴다.md"],
		});
		expect(created).toEqual([
			expect.objectContaining({
				project: "ompdesk",
				path: "_rules/동시-세션-수-제한을-두지-않는다.md",
				sessionId: "main-1",
			}),
			{
				project: "_global",
				path: "preferences/보고는-결론부터-쓴다.md",
				body: expect.stringContaining("> 사용자 메시지 3"),
				tier: "semantic",
				kind: "preference",
			},
		]);
		expect(messages[0]?.user).toContain("- preferences/한-줄-행.md · 설정 행은 한 줄로");
	});

	it("skips a page the project's rules file already states, read from the session's folder", async () => {
		const { client, created } = fakeClient([{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }]);
		const asked: string[] = [];
		const other = { ...rule, title: "보고는 결론부터 쓴다", gist_en: "Reports lead with the conclusion." };
		const outcome = await upkeep(client, {
			model: async message => {
				messages.push(message);
				return answer([
					{ ...rule, gist_en: "No count or rate caps on how many sessions run at the same time." },
					other,
				]);
			},
			rules: async cwd => {
				asked.push(cwd);
				return [
					"# Agent control",
					"- Sessions an agent opened run in their own tabs and report with ompdesk_report.",
					"- **No count or rate caps**: any number of sessions may run at the same time.",
					"- A session in view or typed into is never closed by an agent.",
				].join("\n");
			},
		}).tick();
		expect(asked).toEqual(["/work"]);
		// The model saw the outline before answering; the code check is the backstop for what it still repeats.
		expect(messages[0]?.user).toContain("# Agent control\n- No count or rate caps");
		expect(outcome).toMatchObject({
			created: ["_rules/보고는-결론부터-쓴다.md"],
			inRules: 1,
			refused: [`${rule.title}: the project's rules file already says it`],
		});
		expect(created).toHaveLength(1);
	});

	it("a page that names what it supersedes takes the old one out of recall, once the new one exists", async () => {
		const { client, created, retired } = fakeClient(
			[{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }],
			[
				{
					path: "_rules/세션-수-상한-8개.md",
					title: "세션은 8개까지 연다",
					body: "# 세션은 8개까지 연다\n\n동시에 8개까지만 연다.",
				},
			],
		);
		const outcome = await upkeep(client, {
			model: async message => {
				messages.push(message);
				return answer([{ ...rule, supersedes: "_rules/세션-수-상한-8개.md" }]);
			},
		}).tick();
		// The model was shown the old page, its start included, to name it.
		expect(messages[0]?.user).toContain(
			"- _rules/세션-수-상한-8개.md · 세션은 8개까지 연다 · 동시에 8개까지만 연다.",
		);
		expect(outcome).toMatchObject({
			created: ["_rules/동시-세션-수-제한을-두지-않는다.md"],
			superseded: ["_rules/세션-수-상한-8개.md → _rules/동시-세션-수-제한을-두지-않는다.md"],
		});
		expect(retired).toEqual([
			{
				project: "ompdesk",
				path: "_rules/세션-수-상한-8개.md",
				successor: "_rules/동시-세션-수-제한을-두지-않는다.md",
				at: new Date(T0).toISOString(),
			},
		]);
		expect(created[0]?.body).toContain("_Replaces [[_rules/세션-수-상한-8개.md]]._");
	});

	it("without a named page nothing is superseded, however similar a title is", async () => {
		const { client, retired } = fakeClient(
			[{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }],
			[{ path: "_rules/run-the-checks-before-pushing.md", title: "Run the checks before pushing" }],
		);
		const similar = { ...rule, title: "Run the checks before merging" };
		const outcome = await upkeep(client, { model: async () => answer([similar]) }).tick();
		expect(outcome).toMatchObject({ created: ["_rules/run-the-checks-before-merging.md"], superseded: [] });
		expect(retired).toEqual([]);
	});

	it("never supersedes when the new page was not written, nor a page its owner pinned", async () => {
		const { client, created, retired } = fakeClient(
			[{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }],
			[
				{ path: "_rules/동시-세션-수-제한을-두지-않는다.md", title: "다른 제목" },
				{ path: "_rules/old.md", title: "옛 규칙" },
				{ path: "_rules/pinned.md", title: "고정된 규칙", body: "# 고정된 규칙\n\n본문", pinned: true },
			],
		);
		const pinnedOne = { ...rule, title: "새 규칙", supersedes: "_rules/pinned.md" };
		const outcome = await upkeep(client, {
			model: async () => answer([{ ...rule, supersedes: "_rules/old.md" }, pinnedOne]),
		}).tick();
		expect(retired).toEqual([]);
		expect(outcome).toMatchObject({ duplicates: 1, superseded: [], refused: [] });
		expect(created.map(page => page.path)).toEqual(["_rules/새-규칙.md"]);
		expect(created[0]?.body).not.toContain("Replaces");
	});

	it("does not read the same messages twice: the next window starts after the last one read", async () => {
		const sessions: FakeSession[] = [{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 60_000) }];
		const { client } = fakeClient(sessions);
		const worker = upkeep(client);
		await worker.tick();
		now += UPKEEP_MIN_GAP_MS + 1;
		expect(await worker.tick()).toEqual({ ran: false, reason: "nothing" });
		// Six more messages, quiet again: a second window of only those.
		sessions[0]?.prompts.push(
			...typed(6, 0).map(prompt => ({ ...prompt, at: now - UPKEEP_IDLE_MS - 60_000 + prompt.at - T0 })),
		);
		const outcome = await worker.tick();
		expect(outcome).toMatchObject({ ran: true, prompts: 6 });
		expect(messages[1]?.user).toContain("[9] ");
		expect(messages[1]?.user).not.toContain("[8] ");
	});

	it("leaves conversations alone that are too short, still going, or written by agents", async () => {
		const { client } = fakeClient([
			{ id: "short", prompts: typed(3, UPKEEP_IDLE_MS + 1) },
			{ id: "live", prompts: typed(9, 60_000) },
			{
				id: "child",
				prompts: Array.from({ length: 9 }, (_, index) => ({
					text: wrapAgentMessage(`Title: 일 ${index}\n\nbody`, "부모"),
					at: T0 - UPKEEP_IDLE_MS * 2,
				})),
			},
		]);
		expect(await upkeep(client).tick()).toEqual({ ran: false, reason: "nothing" });
		expect(messages).toEqual([]);
	});

	it("picks the quiet conversation with the most new messages, one per tick, and never the profile's project", async () => {
		const { client } = fakeClient([
			{ id: "small", prompts: typed(6, UPKEEP_IDLE_MS + 1) },
			{ id: "big", prompts: typed(12, UPKEEP_IDLE_MS + 1) },
		]);
		const outcome = await upkeep(client).tick();
		expect(outcome).toMatchObject({ ran: true, session: "big", prompts: 12 });
		expect(messages).toHaveLength(1);
	});

	it("a conversation still going is picked up once its person has been quiet long enough", async () => {
		const { client } = fakeClient([{ id: "live", prompts: typed(9, 60_000) }]);
		const worker = upkeep(client);
		expect(await worker.tick()).toEqual({ ran: false, reason: "nothing" });
		now += UPKEEP_IDLE_MS;
		expect(await worker.tick()).toMatchObject({ ran: true, session: "live" });
	});

	it("is bounded: one run per hour, six per day, nothing while switched off, nothing at the same time", async () => {
		const sessions = Array.from({ length: 9 }, (_, index) => ({
			id: `s${index}`,
			prompts: typed(7, UPKEEP_IDLE_MS * 10),
		}));
		const { client } = fakeClient(sessions);
		let learn = true;
		const worker = upkeep(client, { learn: () => learn });
		expect(await worker.tick()).toMatchObject({ ran: true });
		expect(await worker.tick()).toEqual({ ran: false, reason: "gap" });
		for (let run = 1; run < UPKEEP_DAILY_MAX; run++) {
			now += UPKEEP_MIN_GAP_MS + 1;
			expect(await worker.tick()).toMatchObject({ ran: true });
		}
		now += UPKEEP_MIN_GAP_MS + 1;
		expect(await worker.tick()).toEqual({ ran: false, reason: "daily" });
		expect(messages).toHaveLength(UPKEEP_DAILY_MAX);
		// A day later the allowance is back.
		now += 24 * 60 * 60_000;
		expect(await worker.tick()).toMatchObject({ ran: true });
		learn = false;
		now += UPKEEP_MIN_GAP_MS + 1;
		expect(await worker.tick()).toEqual({ ran: false, reason: "off" });
	});

	it("a failing model counts against the schedule and is read again later; an answer it cannot parse is too", async () => {
		const sessions: FakeSession[] = [{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }];
		const { client, created } = fakeClient(sessions);
		let reply: () => Promise<ModelResult> = async () => {
			throw new Error("omp exited 1: No API key");
		};
		const worker = upkeep(client, { model: () => reply() });
		expect(await worker.tick()).toEqual({ ran: true, failed: "omp exited 1: No API key" });
		expect(logs.at(-1)).toMatchObject({ message: "failed", details: { step: "learn-model", session: "main-1" } });
		now += UPKEEP_MIN_GAP_MS + 1;
		reply = async () => ({ ...answer([]), text: "Sorry, I cannot." });
		expect(await worker.tick()).toMatchObject({ ran: true, refused: ["answer is not a {pages:[…]} object"] });
		now += UPKEEP_MIN_GAP_MS + 1;
		reply = async () => answer([rule]);
		expect(await worker.tick()).toMatchObject({ ran: true, prompts: 8 });
		expect(created).toHaveLength(1);
	});

	it("an empty answer settles the window; a page that already exists is a duplicate, never overwritten", async () => {
		const { client, created } = fakeClient(
			[{ id: "main-1", prompts: typed(8, UPKEEP_IDLE_MS + 1) }],
			[{ path: "_rules/동시-세션-수-제한을-두지-않는다.md", title: "다른 제목" }],
		);
		const worker = upkeep(client);
		expect(await worker.tick()).toMatchObject({ ran: true, created: [], duplicates: 1 });
		expect(created).toEqual([]);
		now += UPKEEP_MIN_GAP_MS + 1;
		expect(await worker.tick()).toEqual({ ran: false, reason: "nothing" });
		const state = JSON.parse(await readFile(join(dir, "upkeep.json"), "utf8"));
		expect(state.sessions["main-1"].done).toBe(8);
		expect(state.runs).toHaveLength(1);
	});

	it("does not ask the server for a session's prompts again while nothing was written to it", async () => {
		const { client, observationCalls } = fakeClient([{ id: "short", prompts: typed(3, UPKEEP_IDLE_MS + 1) }]);
		const worker = upkeep(client);
		await worker.tick();
		await worker.tick();
		expect(observationCalls).toEqual(["short:user-prompt"]);
	});
});

describe("MemoryUpkeep.repair", () => {
	it("logs what it repaired and stays silent when there was nothing to do", async () => {
		const { client } = fakeClient([]);
		const worker = upkeep(client);
		expect(await worker.repair()).toMatchObject({ junk: 0 });
		expect(logs).toEqual([]);
		const handoffs = fakeClient([]);
		handoffs.client.handoffs = async project =>
			project?.project !== "ompdesk"
				? []
				: [
						{
							...PROJECT,
							id: "h1",
							agent: "omp",
							createdAt: null,
							summary: 'Started: <ompdesk-agent-message from="부모">\nTitle: x',
							openQuestions: [],
							nextSteps: [],
							state: "open",
						},
					];
		const cancelled: string[] = [];
		handoffs.client.cancelHandoff = async (_project, id) => {
			cancelled.push(id);
		};
		await upkeep(handoffs.client).repair();
		expect(cancelled).toEqual(["h1"]);
		expect(logs).toEqual([
			{ message: "retitle", details: expect.objectContaining({ childHandoffsDiscarded: 1, openHandoffs: 1 }) },
		]);
	});

	it("never rejects: a server error is a log line", async () => {
		const { client } = fakeClient([]);
		client.projects = async () => {
			throw new Error("Memory is not running");
		};
		expect(await upkeep(client).repair()).toBeNull();
		expect(logs).toEqual([{ message: "failed", details: { step: "retitle", detail: "Memory is not running" } }]);
	});
});
