import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-control";
import type { AiMemoryHandoff, AiMemoryObservation, AiMemoryPage, AiMemoryPageRef } from "../../shared/ai-memory";
import { isChildHandoff, type RetitleClient, retitleMarkdown, retitleSessionPages } from "./retitle";

const PROJECT = { workspace: "default", project: "ompdesk" };
const WRAPPED_TITLE = '<ompdesk-agent-message from="병렬 세션 자동 정리">';
const STOCK_TITLE = "Complete assignment thoroughly:";

interface FakeSession {
	id: string;
	title: string;
	prompts: { title: string; body: string }[];
	tier?: string;
	summary?: string;
}

function pageMarkdown(title: string, session: FakeSession): string {
	return [
		`# ${title}`,
		"",
		"## Session metadata",
		"",
		`- **session_id:** \`${session.id}\``,
		"",
		"## Prompts",
		"",
		...session.prompts.map((prompt, index) => `${index + 1}. ${prompt.title}`),
		"",
		"## Tool calls",
		"",
		`- \`non-file\`: 4`,
		"",
		"## Raw observations",
		"",
		"- `session-start` @ 2026-10-19T01:00:53Z — claude-opus-5-5",
		...session.prompts.map(prompt => `- \`user-prompt\` @ 2026-10-19T01:00:57Z — ${prompt.title}`),
		"- `pre-tool-use` @ 2026-10-19T01:01:03Z — tool file",
		"",
	].join("\n");
}

/** A stateful stand-in for the server: the pages, the observations of each session and the handoffs. */
function fakeServer(sessions: FakeSession[], handoffs: AiMemoryHandoff[] = [], extraPages: AiMemoryPageRef[] = []) {
	const titles = new Map(sessions.map(session => [`sessions/${session.id}.md`, session.title]));
	const markdown = new Map(
		sessions.map(session => [`sessions/${session.id}.md`, pageMarkdown(session.title, session)]),
	);
	const versions = new Map<string, number>();
	const writes: Parameters<RetitleClient["writeSessionPage"]>[0][] = [];
	const cancelled: string[] = [];
	const client: RetitleClient = {
		projects: async () => [{ ...PROJECT, pages: sessions.length, lastUpdated: null }],
		pages: async () => [
			...sessions.map(session => ({
				...PROJECT,
				path: `sessions/${session.id}.md`,
				title: titles.get(`sessions/${session.id}.md`) ?? "",
				kind: "session",
				updatedAt: null,
				tier: session.tier ?? "episodic",
			})),
			...extraPages,
		],
		page: async ref => {
			const session = sessions.find(candidate => `sessions/${candidate.id}.md` === ref.path);
			if (!session) throw new Error("no such page");
			const page: AiMemoryPage = {
				updatedAt: null,
				...PROJECT,
				path: ref.path,
				title: titles.get(ref.path) ?? "",
				markdown: markdown.get(ref.path) ?? "",
				id: `${ref.path}@${versions.get(ref.path) ?? 0}`,
				pinned: false,
				createdAt: null,
				tags: [],
				tier: session.tier ?? "episodic",
				...(session.summary ? { summary: session.summary } : {}),
			};
			return page;
		},
		observations: async (_project, sessionId) => {
			const session = sessions.find(candidate => candidate.id === sessionId);
			const observations: AiMemoryObservation[] = [
				{ id: "o0", kind: "session-start", title: "claude-opus-5-5", body: "", createdAt: null },
				...(session?.prompts ?? []).map((prompt, index) => ({
					id: `o${index + 1}`,
					kind: "user-prompt",
					title: prompt.title,
					body: prompt.body,
					createdAt: null,
				})),
			];
			return {
				session: {
					id: sessionId,
					cwd: "",
					agent: "omp",
					startedAt: null,
					endedAt: null,
					observations: observations.length,
					consolidation: null,
				},
				observations,
				total: observations.length,
				offset: 0,
			};
		},
		writeSessionPage: async input => {
			// The server's precondition: only the version the caller read may be replaced.
			if (input.expectedPageId !== `${input.path}@${versions.get(input.path) ?? 0}`) {
				throw new Error("memory_write_page: precondition_failed");
			}
			writes.push(input);
			titles.set(input.path, input.body.split("\n")[0]?.replace(/^# /, "") ?? "");
			markdown.set(input.path, input.body);
			versions.set(input.path, (versions.get(input.path) ?? 0) + 1);
		},
		handoffs: async () => handoffs,
		cancelHandoff: async (_project, id) => {
			cancelled.push(id);
		},
	};
	return { client, writes, cancelled, titles, markdown, versions };
}

const childPrompt = (title: string, from = "병렬 세션 자동 정리") => ({
	title: `<ompdesk-agent-message from="${from}">`,
	body: wrapAgentMessage(`Title: ${title}\n\nRepo: OMPdesk…`, from),
});
const subagentPrompt = (title: string) => ({
	title: STOCK_TITLE,
	body: `${STOCK_TITLE}\n\nTitle: ${title}\n\nIn the first-run step…`,
});

const handoff = (id: string, summary: string, state = "open"): AiMemoryHandoff => ({
	...PROJECT,
	id,
	agent: "omp",
	createdAt: null,
	summary,
	openQuestions: [],
	nextSteps: [],
	state,
});

describe("retitleSessionPages", () => {
	it("names a wrapped, a subagent and a person's session by their task and leaves real titles alone", async () => {
		const server = fakeServer([
			{
				id: "a1",
				title: WRAPPED_TITLE,
				prompts: [childPrompt("맥 자동업데이트 확인"), childPrompt("두번째 일", "다른 부모")],
				summary: "2 prompts",
			},
			{ id: "b2", title: STOCK_TITLE, prompts: [subagentPrompt("시작하기에서 주요 프로바이더를 맨 위에")] },
			{
				id: "c3",
				title: "이제 업데이트 완료했어",
				prompts: [{ title: "이제 업데이트 완료했어", body: "이제 업데이트 완료했어" }],
			},
		]);
		const report = await retitleSessionPages(server.client, { dryRun: false });

		expect(report).toMatchObject({
			dryRun: false,
			projects: 1,
			sessionPages: 3,
			junk: 2,
			unresolved: [],
			changed: [],
			failed: [],
		});
		expect(report.retitled.map(item => [item.path, item.from, item.to])).toEqual([
			["sessions/a1.md", WRAPPED_TITLE, "맥 자동업데이트 확인"],
			["sessions/b2.md", STOCK_TITLE, "시작하기에서 주요 프로바이더를 맨 위에"],
		]);
		expect(server.writes.map(write => write.path)).toEqual(["sessions/a1.md", "sessions/b2.md"]);
		const first = server.writes[0];
		expect(first).toMatchObject({
			...PROJECT,
			sessionId: "a1",
			expectedPageId: "sessions/a1.md@0",
			tier: "episodic",
			abstract: "2 prompts",
		});
		// The heading, the prompt list and the raw observation lines of the page say the new title; nothing else moved.
		const body = server.markdown.get("sessions/a1.md") ?? "";
		expect(body).toContain("# 맥 자동업데이트 확인\n");
		expect(body).toContain("1. 맥 자동업데이트 확인\n2. 두번째 일\n");
		expect(body).toContain("- `user-prompt` @ 2026-10-19T01:00:57Z — 맥 자동업데이트 확인\n");
		expect(body).not.toContain("ompdesk-agent-message");
		expect(body).toContain("- `pre-tool-use` @ 2026-10-19T01:01:03Z — tool file");
		expect(server.markdown.get("sessions/c3.md")).toContain("# 이제 업데이트 완료했어");
	});

	it("a dry run plans the same and writes nothing", async () => {
		const sessions = [
			{ id: "a1", title: WRAPPED_TITLE, prompts: [childPrompt("맥 자동업데이트 확인")] },
			{ id: "b2", title: STOCK_TITLE, prompts: [subagentPrompt("프로바이더")] },
		];
		const dry = fakeServer(sessions, [handoff("h1", `Started: ${WRAPPED_TITLE}\nTitle: x`)]);
		const dryReport = await retitleSessionPages(dry.client, { dryRun: true });
		expect(dry.writes).toEqual([]);
		expect(dry.cancelled).toEqual([]);
		const applied = fakeServer(sessions, [handoff("h1", `Started: ${WRAPPED_TITLE}\nTitle: x`)]);
		const appliedReport = await retitleSessionPages(applied.client, { dryRun: false });
		expect({ ...dryReport, dryRun: false }).toEqual(appliedReport);
		expect(dryReport.retitled).toHaveLength(2);
		expect(dryReport.childHandoffs).toBe(1);
	});

	it("is idempotent: a second run finds nothing to do", async () => {
		const server = fakeServer([{ id: "a1", title: WRAPPED_TITLE, prompts: [childPrompt("맥 자동업데이트 확인")] }]);
		await retitleSessionPages(server.client, { dryRun: false });
		const second = await retitleSessionPages(server.client, { dryRun: false });
		expect(second).toMatchObject({ junk: 0, retitled: [], unresolved: [], failed: [] });
		expect(server.writes).toHaveLength(1);
	});

	it("tells two sessions of one task apart by the short id, the way the server does", async () => {
		const server = fakeServer(
			[
				{ id: "aaaaaaaa-1111", title: WRAPPED_TITLE, prompts: [childPrompt("같은 일")] },
				{ id: "bbbbbbbb-2222", title: STOCK_TITLE, prompts: [subagentPrompt("같은 일")] },
			],
			[],
			[
				{
					...PROJECT,
					path: "decisions/other.md",
					title: "다른 페이지",
					kind: "decision",
					tier: "semantic",
					updatedAt: null,
				},
			],
		);
		const report = await retitleSessionPages(server.client, { dryRun: false });
		expect(report.retitled.map(item => item.to)).toEqual(["같은 일", "같은 일 (session bbbbbbbb)"]);
	});

	it("leaves a junk page whose session has no usable prompt, and one another writer changed meanwhile", async () => {
		const empty = fakeServer([
			{ id: "a1", title: STOCK_TITLE, prompts: [{ title: STOCK_TITLE, body: STOCK_TITLE }] },
		]);
		expect(await retitleSessionPages(empty.client, { dryRun: false })).toMatchObject({
			junk: 1,
			unresolved: ["sessions/a1.md"],
			retitled: [],
		});
		expect(empty.writes).toEqual([]);

		const racing = fakeServer([{ id: "a1", title: WRAPPED_TITLE, prompts: [childPrompt("맥 자동업데이트 확인")] }]);
		const page = racing.client.page;
		racing.client.page = async ref => {
			const result = await page(ref);
			// A SessionEnd rewrites the page after it was read and before it is written.
			racing.versions.set(ref.path, 5);
			return result;
		};
		const report = await retitleSessionPages(racing.client, { dryRun: false });
		expect(report).toMatchObject({ changed: ["sessions/a1.md"], retitled: [], failed: [] });
		expect(racing.writes).toEqual([]);
	});

	it("one failing page does not stop the others", async () => {
		const server = fakeServer([
			{ id: "a1", title: WRAPPED_TITLE, prompts: [childPrompt("첫째")] },
			{ id: "b2", title: STOCK_TITLE, prompts: [subagentPrompt("둘째")] },
		]);
		const write = server.client.writeSessionPage;
		server.client.writeSessionPage = async input => {
			if (input.path === "sessions/a1.md") throw new Error("disk full");
			await write(input);
		};
		const report = await retitleSessionPages(server.client, { dryRun: false });
		expect(report.failed).toEqual(["sessions/a1.md: disk full"]);
		expect(report.retitled.map(item => item.to)).toEqual(["둘째"]);
	});

	it("discards the open handoffs children left and keeps a person's", async () => {
		const server = fakeServer(
			[],
			[
				handoff("child-1", `Started: ${WRAPPED_TITLE}\nTitle: 군더더기 정리\n\nFIRST: git fetch`),
				handoff("child-2", "Session focused on: Complete assignment thoroughly:\n\nTitle: 시작하기\n\nIn the"),
				handoff("main-1", "Session focused on: 이제 업데이트 완료했어 AI 메모리도 승인해놨고"),
				handoff("done-1", `Started: ${WRAPPED_TITLE}\nTitle: 이미 처리됨`, "accepted"),
			],
		);
		const report = await retitleSessionPages(server.client, { dryRun: false });
		expect(server.cancelled).toEqual(["child-1", "child-2"]);
		expect(report).toMatchObject({ openHandoffs: 3, childHandoffs: 2 });
	});
});

describe("isChildHandoff", () => {
	it("reads the summary's subject, only for an open handoff", () => {
		expect(isChildHandoff(handoff("a", `Started: ${WRAPPED_TITLE}\nTitle: x`))).toBe(true);
		expect(isChildHandoff(handoff("a", "Session focused on: Complete assignment thoroughly:\n\nTitle: x"))).toBe(
			true,
		);
		expect(isChildHandoff(handoff("a", "Session focused on: 고쳐줘"))).toBe(false);
		expect(isChildHandoff(handoff("a", "no lead-in"))).toBe(false);
		expect(isChildHandoff(handoff("a", `Started: ${WRAPPED_TITLE}`, "expired"))).toBe(false);
	});
});

describe("retitleMarkdown", () => {
	it("only rewrites where the page prints a title: the heading, the prompt list, the raw prompt lines", () => {
		const text = [
			`# ${WRAPPED_TITLE}`,
			"",
			"## Prompts",
			"",
			`1. ${WRAPPED_TITLE}`,
			"",
			"## Notes",
			"",
			`1. ${WRAPPED_TITLE}`,
			`mentions ${WRAPPED_TITLE} in prose`,
			"",
		].join("\n");
		const out = retitleMarkdown(text, WRAPPED_TITLE, "새 제목", new Map([[WRAPPED_TITLE, "새 제목"]]));
		expect(out.split("\n")).toEqual([
			"# 새 제목",
			"",
			"## Prompts",
			"",
			"1. 새 제목",
			"",
			"## Notes",
			"",
			`1. ${WRAPPED_TITLE}`,
			`mentions ${WRAPPED_TITLE} in prose`,
			"",
		]);
	});

	it("matches a prompt title the page cut with an ellipsis, when only one title can be meant", () => {
		const long = `${"가".repeat(30)}긴 제목`;
		const out = retitleMarkdown(
			`# x\n\n## Prompts\n\n1. ${long.slice(0, 20)}…\n`,
			"x",
			"y",
			new Map([[long, "짧은"]]),
		);
		expect(out).toContain("1. 짧은");
	});
});
