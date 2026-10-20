import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiMemoryProjectRef, AiMemorySession } from "../../shared/ai-memory";
import { type BackfillClient, type BackfillDeps, backfillConclusions } from "./backfill";
import type { MemoryConclusionCopy } from "./client";

const OMPDESK: AiMemoryProjectRef = { workspace: "default", project: "ompdesk" };
const OTHER: AiMemoryProjectRef = { workspace: "default", project: "other" };
const ORIGIN = "device-mac";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const MINUTE = 60_000;

let seq = 0;
const uuid = (): string => `01a14f00-0000-7000-8000-${String(++seq).padStart(12, "0")}`;

function assistant(text: string, at: number, stopReason = "stop"): unknown {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: at };
}
const user = (text: string, at: number): unknown => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: at,
});

interface FakeSession {
	id: string;
	cwd: string;
	project: AiMemoryProjectRef;
	title?: string;
}

/** A stateful stand-in for the server: its sessions (paged like the real route), native conclusions and written copies. */
function fakeServer(options: {
	sessions?: FakeSession[];
	natives?: (MemoryConclusionCopy & { seq: number })[];
	store?: string;
}) {
	const sessions = options.sessions ?? [];
	const natives = options.natives ?? [];
	const written = new Map<
		string,
		{ project: AiMemoryProjectRef; origin: string; title: string; body: string; at: string; sessionId: string }
	>();
	const calls = { writes: 0, nativeReads: 0 };
	const state = { store: options.store ?? "store-1", failWrites: false };
	const client: BackfillClient = {
		projects: async () => [OMPDESK, OTHER].map(project => ({ ...project, pages: 0, lastUpdated: null })),
		sessions: async (project, limit = 30, offset = 0): Promise<AiMemorySession[]> =>
			sessions
				.filter(session => session.project.project === project.project)
				.slice(offset, offset + limit)
				.map(session => ({
					id: session.id,
					cwd: session.cwd,
					agent: "omp",
					startedAt: null,
					endedAt: null,
					observations: 1,
					consolidation: null,
				})),
		pages: async project =>
			sessions
				.filter(session => session.project.project === project.project && session.title)
				.map(session => ({
					...project,
					path: `sessions/${session.id}.md`,
					title: session.title ?? "",
					updatedAt: null,
				})),
		conclusions: async (_source, after, limit) => {
			calls.nativeReads++;
			const rows = natives.filter(row => row.seq > after).slice(0, limit);
			return {
				rows,
				next: rows.at(-1)?.seq ?? after,
				more: natives.filter(row => row.seq > after).length > rows.length,
				store: state.store,
				last: natives.at(-1)?.seq ?? 0,
			};
		},
		writeConclusions: async (project, origin, items) => {
			if (state.failWrites) throw new Error("server down");
			calls.writes++;
			return items.map(item => {
				if (!item.body.trim()) return "skipped";
				if (written.has(item.id)) return "same";
				written.set(item.id, {
					project,
					origin,
					title: item.title,
					body: item.body,
					at: item.at,
					sessionId: item.sessionId,
				});
				return "written";
			});
		},
	};
	return { client, written, calls, state };
}

describe("backfillConclusions", () => {
	let dir: string;
	let messages: Map<string, unknown[]>;
	let memo: Record<string, unknown>;
	let logs: { message: string; details: Record<string, unknown> }[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "backfill-"));
		messages = new Map();
		memo = {};
		logs = [];
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** A journal on disk (stock layout, header only) whose transcript `readMessages` answers. */
	async function journal(
		relative: string,
		header: { id: string; cwd?: string; title?: string },
		transcript: unknown[],
	) {
		const path = join(dir, "sessions", relative);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(
			path,
			[
				JSON.stringify({ type: "title", v: 1, title: "ignored", pad: " ".repeat(120) }),
				JSON.stringify({ type: "session", version: 3, timestamp: "2026-10-18T00:00:00Z", ...header }),
				JSON.stringify({ type: "message", id: "m1" }),
			].join("\n"),
		);
		messages.set(path, transcript);
		return path;
	}

	function deps(client: BackfillClient, extra: Partial<BackfillDeps> = {}): BackfillDeps {
		return {
			client,
			sessionsDir: join(dir, "sessions"),
			readMessages: async path => messages.get(path) ?? [],
			origin: ORIGIN,
			memo,
			log: (message, details) => logs.push({ message, details }),
			now: () => NOW,
			...extra,
		};
	}

	const native = (
		session: string,
		at: string,
		body: string,
		seqNo: number,
	): MemoryConclusionCopy & { seq: number } => ({
		...OMPDESK,
		seq: seqNo,
		id: `obs-${seqNo}`,
		sessionId: session.replaceAll("-", ""),
		title: "t",
		body,
		at,
	});

	it("writes the last reply of each run of a mapped session, redacted, under this computer's origin", async () => {
		const id = uuid();
		const server = fakeServer({
			sessions: [{ id, cwd: "/work/app", project: OMPDESK, title: "Fix the login" }],
			natives: [native(uuid(), "2026-10-19T22:00:00Z", "later", 1)],
		});
		const t1 = Date.parse("2026-10-10T10:00:00Z");
		await journal("-work-app/2026-10-10T10-00-00-000Z_x.jsonl", { id, cwd: "/work/app" }, [
			user("fix it", t1 - 5000),
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", id: "1" },
				],
				stopReason: "toolUse",
				timestamp: t1 - 4000,
			},
			{ role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: t1 - 3000 },
			assistant("Fixed the token check. Key is ghp_abcdefghijklmnopqrstuvwxyz0123456789ab", t1),
			{ role: "custom", customType: "goal-mode-context", content: "x", timestamp: t1 + 1 },
			assistant("Second run: added a test.", t1 + 60_000),
		]);
		const report = await backfillConclusions(deps(server.client));
		expect(report).toMatchObject({ mappedById: 1, turns: 2, written: 2, failed: false });
		const rows = [...server.written.entries()];
		expect(rows.map(([rowId]) => rowId)).toEqual([`backfill:${id}:${t1}`, `backfill:${id}:${t1 + 60_000}`]);
		const first = rows[0]?.[1];
		expect(first).toMatchObject({
			origin: ORIGIN,
			project: OMPDESK,
			title: "Fix the login",
			sessionId: id,
			at: new Date(t1).toISOString(),
		});
		expect(first?.body).toContain("Fixed the token check.");
		expect(first?.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ab");
		expect(first?.body).not.toContain("hmm");
	});

	it("does not take text a run said on its way to a tool call", async () => {
		const id = uuid();
		const server = fakeServer({ sessions: [{ id, cwd: "/work/app", project: OMPDESK }] });
		const at = Date.parse("2026-10-10T10:00:00Z");
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("I will read the file first.", at - 2000, "toolUse"),
			assistant("The file is fine.", at),
		]);
		await backfillConclusions(deps(server.client));
		expect([...server.written.values()].map(row => row.body)).toEqual(["The file is fine."]);
	});

	it("takes the title of the first prompt when the server holds no page for the session", async () => {
		const known = uuid();
		const server = fakeServer({ sessions: [{ id: known, cwd: "/work/app", project: OMPDESK }] });
		const journalId = uuid();
		await journal("-work-app/2026-10-10T10-00-00-000Z_x/1-Scout.jsonl", { id: journalId, cwd: "/work/app" }, [
			user("Complete assignment thoroughly:\nTitle: 로그인 점검\n\nlook at it", 1),
			assistant("done", Date.parse("2026-10-10T10:00:00Z")),
		]);
		await backfillConclusions(deps(server.client));
		expect([...server.written.values()][0]?.title).toBe("로그인 점검");
	});

	it("copies a session an agent started only when its brief names the task with a Title: line", async () => {
		const known = uuid();
		const server = fakeServer({ sessions: [{ id: known, cwd: "/work/app", project: OMPDESK }] });
		const at = Date.parse("2026-10-10T10:00:00Z");
		const person = uuid();
		const titled = uuid();
		const plumbing = uuid();
		const opened = uuid();
		await journal("-work-app/p.jsonl", { id: person, cwd: "/work/app" }, [
			user("왜 로그인이 안 돼?", at - 1000),
			assistant("토큰 만료 검사가 빠져 있었어요.", at),
		]);
		await journal("-work-app/p/1-Task.jsonl", { id: titled, cwd: "/work/app" }, [
			user("Complete assignment thoroughly:\nTitle: 로그인 점검\n\nlook at it", at - 1000),
			assistant("Checked the token path.", at),
		]);
		await journal("-work-app/p/2-Task.jsonl", { id: plumbing, cwd: "/work/app" }, [
			user("Complete assignment thoroughly:\n# Target\nRead history://FlakeHunt2 §1.", at - 1000),
			assistant("Read it; nothing new.", at),
		]);
		await journal("-work-app/o.jsonl", { id: opened, cwd: "/work/app" }, [
			user('<ompdesk-agent-message from="Boss">\nContinue Shell3\'s work.\n</ompdesk-agent-message>', at - 1000),
			assistant("Continued.", at),
		]);
		const report = await backfillConclusions(deps(server.client));
		expect(report).toMatchObject({ untitled: 2, written: 2 });
		expect([...server.written.values()].map(row => row.sessionId).sort()).toEqual([person, titled].sort());
		expect((await backfillConclusions(deps(server.client))).written).toBe(0);
	});

	it("maps by the folder only when every known session there belongs to one project, and counts what it skips", async () => {
		const server = fakeServer({
			sessions: [
				{ id: uuid(), cwd: "/solo", project: OMPDESK },
				{ id: uuid(), cwd: "/shared", project: OMPDESK },
				{ id: uuid(), cwd: "/shared", project: OTHER },
			],
		});
		const at = Date.parse("2026-10-10T10:00:00Z");
		const reply = [user("q", at - 1), assistant("answer", at)];
		await journal("-solo/a.jsonl", { id: uuid(), cwd: "/solo" }, reply);
		await journal("-shared/b.jsonl", { id: uuid(), cwd: "/shared" }, reply);
		await journal("-nowhere/c.jsonl", { id: uuid(), cwd: "/nowhere" }, reply);
		await journal("-solo/__advisor.jsonl", { id: uuid(), cwd: "/solo" }, reply);
		const broken = join(dir, "sessions", "-solo", "d.jsonl");
		await writeFile(broken, "not json\n");
		const report = await backfillConclusions(deps(server.client));
		expect(report).toMatchObject({ journals: 4, mappedByCwd: 1, ambiguous: 1, unmapped: 1, noHeader: 1, written: 1 });
		expect([...server.written.values()].map(row => row.project)).toEqual([OMPDESK]);
	});

	it("finds a session past the server's first 100 in a project", async () => {
		const sessions: FakeSession[] = Array.from({ length: 130 }, (_, index) => ({
			id: uuid(),
			cwd: `/f${index}`,
			project: OMPDESK,
		}));
		const server = fakeServer({ sessions });
		const last = sessions[129] as FakeSession;
		await journal("-f/last.jsonl", { id: last.id, cwd: "/elsewhere" }, [
			assistant("old answer", Date.parse("2026-10-10T10:00:00Z")),
		]);
		const report = await backfillConclusions(deps(server.client));
		expect(report).toMatchObject({ mappedById: 1, written: 1 });
	});

	it("leaves the turns the server captured itself", async () => {
		const id = uuid();
		const cut = Date.parse("2026-10-19T22:00:00Z");
		const server = fakeServer({
			sessions: [{ id, cwd: "/work/app", project: OMPDESK }],
			natives: [
				native(id, new Date(cut + 8000).toISOString(), "The turn the server kept itself", 1),
				native(uuid(), "2026-10-19T21:49:56Z", "another session, earlier start of capture", 2),
			],
		});
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("An old turn", cut - 3_600_000),
			assistant("The turn the server kept itself", cut),
			assistant("A later turn the server also kept", cut + 3_600_000),
		]);
		const report = await backfillConclusions(deps(server.client));
		expect(report.written).toBe(1);
		expect([...server.written.values()].map(row => row.body)).toEqual(["An old turn"]);
	});

	it("uses the start of capture for a session with no native conclusion, and ten minutes ago when the store has none", async () => {
		const id = uuid();
		const withNatives = fakeServer({
			sessions: [{ id, cwd: "/work/app", project: OMPDESK }],
			natives: [native(uuid(), "2026-10-19T21:49:56Z", "x", 1)],
		});
		const at = Date.parse("2026-10-19T21:49:56Z");
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("before capture", at - 1000),
			assistant("after capture began", at + 1000),
		]);
		await backfillConclusions(deps(withNatives.client));
		expect([...withNatives.written.values()].map(row => row.body)).toEqual(["before capture"]);

		const empty = fakeServer({ sessions: [{ id, cwd: "/work/app", project: OMPDESK }] });
		messages.set([...messages.keys()][0] as string, [
			assistant("an hour ago", NOW - 60 * MINUTE),
			assistant("a minute ago, its Stop may still arrive", NOW - MINUTE),
		]);
		await backfillConclusions(deps(empty.client, { memo: {} }));
		expect([...empty.written.values()].map(row => row.body)).toEqual(["an hour ago"]);
	});

	it("writes nothing new on a second pass, with or without the state", async () => {
		const id = uuid();
		const server = fakeServer({
			sessions: [{ id, cwd: "/work/app", project: OMPDESK }],
			natives: [native(uuid(), "2026-10-19T22:00:00Z", "x", 1)],
		});
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("one", Date.parse("2026-10-10T10:00:00Z")),
		]);
		expect(await backfillConclusions(deps(server.client))).toMatchObject({ written: 1, read: 1 });
		memo = JSON.parse(JSON.stringify(memo));
		const again = await backfillConclusions(deps(server.client));
		expect(again).toMatchObject({ written: 0, same: 0, read: 0, done: 1 });
		expect(logs.filter(log => log.message === "care-backfill")).toHaveLength(1);
		const stateless = await backfillConclusions(deps(server.client, { memo: {} }));
		expect(stateless).toMatchObject({ written: 0, same: 1, read: 1 });
	});

	it("starts over for a new store", async () => {
		const id = uuid();
		const first = fakeServer({ sessions: [{ id, cwd: "/work/app", project: OMPDESK }], store: "store-a" });
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("one", Date.parse("2026-10-10T10:00:00Z")),
		]);
		await backfillConclusions(deps(first.client));
		const second = fakeServer({ sessions: [{ id, cwd: "/work/app", project: OMPDESK }], store: "store-b" });
		expect(await backfillConclusions(deps(second.client))).toMatchObject({ read: 1, written: 1 });
	});

	it("reads and writes within its budget and goes on from the state", async () => {
		const sessions: FakeSession[] = [0, 1, 2].map(index => ({ id: uuid(), cwd: `/f${index}`, project: OMPDESK }));
		const server = fakeServer({ sessions, natives: [native(uuid(), "2026-10-19T22:00:00Z", "x", 1)] });
		for (const [index, session] of sessions.entries()) {
			await journal(`-f/${index}.jsonl`, { id: session.id, cwd: session.cwd }, [
				assistant(`answer ${index}`, Date.parse("2026-10-10T10:00:00Z") + index),
			]);
		}
		const one = await backfillConclusions(deps(server.client, { maxJournals: 2 }));
		expect(one).toMatchObject({ read: 2, written: 2, remaining: 1 });
		const two = await backfillConclusions(deps(server.client, { maxJournals: 2 }));
		expect(two).toMatchObject({ read: 1, written: 1, remaining: 0, done: 2 });
		expect(server.written.size).toBe(3);
	});

	it("stops on a failed write and reads that journal again next time", async () => {
		const id = uuid();
		const server = fakeServer({
			sessions: [{ id, cwd: "/work/app", project: OMPDESK }],
			natives: [native(uuid(), "2026-10-19T22:00:00Z", "x", 1)],
		});
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("one", Date.parse("2026-10-10T10:00:00Z")),
		]);
		server.state.failWrites = true;
		expect(await backfillConclusions(deps(server.client))).toMatchObject({ failed: true, written: 0, remaining: 1 });
		server.state.failWrites = false;
		expect(await backfillConclusions(deps(server.client))).toMatchObject({ failed: false, written: 1 });
	});

	it("logs one care-backfill line per pass that read a journal, and none when there was nothing to do", async () => {
		const server = fakeServer({ sessions: [] });
		await backfillConclusions(deps(server.client));
		expect(logs).toEqual([]);
		const id = uuid();
		const withSession = fakeServer({ sessions: [{ id, cwd: "/work/app", project: OMPDESK }] });
		await journal("-work-app/a.jsonl", { id, cwd: "/work/app" }, [
			assistant("one", Date.parse("2026-10-10T10:00:00Z")),
		]);
		await backfillConclusions(deps(withSession.client));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ message: "care-backfill", details: { written: 1, read: 1, mappedById: 1 } });
	});
});
