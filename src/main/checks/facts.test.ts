import { afterEach, describe, expect, it } from "vitest";
import type { LocalPool, MainFact } from "../../shared/checks-contract";
import type { RemoteLinkState } from "../../shared/ipc-types";
import { CoreChecksHub } from "./client";
import { ChecksFacts, type ChecksFactsDeps, githubRepoOf, savedIdOfPath } from "./facts";

const GH = { bin: "/usr/bin/gh", args: [], env: { GH_TOKEN: "gho_secret" }, timeoutMs: 1000, maxBytes: 1000 };
const GIT = { bin: "/usr/bin/git", args: [], env: {}, timeoutMs: 1000, maxBytes: 1000 };
const SESSION_FILE = "/Users/me/.omp/agent/sessions/-Users-me-app/2026-11-13T10-00-00_0a1b2c3d.jsonl";

const pool = (asOf: number): LocalPool => ({
	device: "local",
	os: "macos",
	slots: 2,
	held: 1,
	queued: 0,
	oldestWaitMs: 0,
	volumes: [{ path: "/", freeGb: 120, totalGb: 460, low: false }],
	asOf,
	offline: false,
	foreign: [],
});

interface World {
	projects: string[];
	origins: Record<string, string>;
	sessions: { tag: string; sessionPath?: string }[];
	hosts: { deviceId: string; state: RemoteLinkState }[];
	asOf: number;
	logged: string[];
}

function world(): World {
	return {
		projects: ["/work/app", "/work/site", "/work/notes"],
		origins: { "/work/app": "git@github.com:Example/app.git", "/work/site": "https://github.com/example/site" },
		sessions: [{ tag: "3f9a", sessionPath: SESSION_FILE }, { tag: "77aa" }],
		hosts: [{ deviceId: "device-mini", state: "online" }],
		asOf: 1000,
		logged: [],
	};
}

function deps(hub: ChecksFactsDeps["hub"], w: World): ChecksFactsDeps {
	return {
		hub,
		runners: async () => ({ gh: GH, git: GIT, home: "/Users/me" }),
		projects: () => w.projects,
		originUrl: async folder => w.origins[folder] ?? null,
		sessions: () => w.sessions,
		hosts: () => w.hosts,
		hostPool: async () => pool(w.asOf),
		log: (message, details) => void w.logged.push(`${message} ${JSON.stringify(details)}`),
	};
}

const stops: (() => void)[] = [];
const opened: CoreChecksHub[] = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	for (const hub of opened.splice(0)) await hub.close();
});

/** A hub that records what it is told, in order. */
function recorder() {
	const told: (MainFact | { kind: "runners"; gh: boolean; git: boolean; home: string })[] = [];
	return {
		told,
		hub: {
			told: async (fact: MainFact) => void told.push(fact),
			runners: async (gh: unknown, git: unknown, home: string) =>
				void told.push({ kind: "runners", gh: gh !== null, git: git !== null, home }),
		},
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

describe("what main tells the checks hub", () => {
	it("reaches the core's hub: runners, the sidebar's GitHub repositories, session tags and a paired computer's pool", async () => {
		const hub = new CoreChecksHub({ fake: true });
		opened.push(hub);
		const facts = new ChecksFacts(deps(hub, world()));
		stops.push(facts.start());
		let calls = (await hub.apply({ op: "calls" })) ?? [];
		while (calls.length < 4) {
			await settle();
			calls = (await hub.apply({ op: "calls" })) ?? [];
		}
		const byKind = Object.fromEntries(
			calls.map(call => [call.op === "runners" ? "runners" : (call.request as MainFact).kind, call.request]),
		);
		expect(byKind.runners).toEqual({ gh: true, git: true });
		expect(byKind.repos).toEqual({ kind: "repos", repos: ["Example/app", "example/site"] });
		// The tab with no session file yet names no session.
		expect(byKind.sessions).toEqual({
			kind: "sessions",
			tags: { "3f9a": { kind: "session", session: "0a1b2c3d", device: "local" } },
		});
		expect(byKind.devicePool).toEqual({ kind: "devicePool", pool: { ...pool(1000), device: "device-mini" } });
		expect(JSON.stringify(calls)).not.toContain("gho_secret");
	});

	it("says nothing twice, and everything again to a hub that started over", async () => {
		const { told, hub } = recorder();
		const w = world();
		w.hosts = [];
		const facts = new ChecksFacts(deps(hub, w));
		stops.push(facts.start());
		await settle();
		expect(told.map(fact => fact.kind).sort()).toEqual(["repos", "runners", "sessions"]);

		facts.reposChanged();
		facts.sessionsChanged();
		facts.runnersChanged();
		await settle();
		expect(told).toHaveLength(3);

		w.sessions = [{ tag: "77aa", sessionPath: SESSION_FILE.replace("0a1b2c3d", "9e8d") }];
		facts.sessionsChanged();
		await settle();
		expect(told.at(-1)).toEqual({
			kind: "sessions",
			tags: { "77aa": { kind: "session", session: "9e8d", device: "local" } },
		});

		facts.hubLost();
		await settle();
		expect(
			told
				.slice(4)
				.map(fact => fact.kind)
				.sort(),
		).toEqual(["repos", "runners", "sessions"]);
	});

	it("reads a paired computer's pool on every round and says its link is lost only once it had one", async () => {
		const { told, hub } = recorder();
		const w = world();
		w.hosts = [{ deviceId: "device-mini", state: "offline" }];
		const facts = new ChecksFacts(deps(hub, w));
		stops.push(facts.start());
		await settle();
		expect(told.some(fact => fact.kind === "deviceOffline")).toBe(false);

		w.hosts = [{ deviceId: "device-mini", state: "online" }];
		facts.hostsChanged();
		await settle();
		w.asOf = 2000;
		facts.hostsChanged();
		await settle();
		const pools = told.filter(fact => fact.kind === "devicePool");
		expect(pools.map(fact => (fact.kind === "devicePool" ? fact.pool.asOf : 0))).toEqual([1000, 2000]);

		w.hosts = [{ deviceId: "device-mini", state: "connecting" }];
		facts.hostsChanged();
		facts.hostsChanged();
		await settle();
		expect(told.filter(fact => fact.kind === "deviceOffline")).toEqual([
			{ kind: "deviceOffline", device: "device-mini" },
		]);
	});

	it("tries a fact the hub refused again at the next change, and logs the refusal once", async () => {
		const w = world();
		w.hosts = [];
		let refuse = true;
		const told: MainFact[] = [];
		const facts = new ChecksFacts(
			deps(
				{
					told: async fact => {
						if (refuse) throw new Error("not_built");
						told.push(fact);
					},
					runners: async () => {},
				},
				w,
			),
		);
		stops.push(facts.start());
		await settle();
		facts.reposChanged();
		await settle();
		expect(w.logged.filter(line => line.includes('"what":"repos"'))).toHaveLength(1);

		refuse = false;
		facts.reposChanged();
		await settle();
		expect(told).toEqual([{ kind: "repos", repos: ["Example/app", "example/site"] }]);
	});
});

describe("githubRepoOf", () => {
	it.each([
		["git@github.com:Example/app.git", "Example/app"],
		["https://github.com/example/site", "example/site"],
		["https://github.com/example/site.git/", "example/site"],
		["https://token@github.com/example/site.git", "example/site"],
		["ssh://git@github.com/example/my.repo.git", "example/my.repo"],
	])("reads %s as %s", (url, repo) => {
		expect(githubRepoOf(url)).toBe(repo);
	});

	it.each(["https://gitlab.com/example/app.git", "git@github.example.com:a/b.git", "/srv/git/app.git"])(
		"reads %s as no GitHub repository",
		url => {
			expect(githubRepoOf(url)).toBeNull();
		},
	);
});

describe("savedIdOfPath", () => {
	it("reads the id after the time in a session file's name", () => {
		expect(savedIdOfPath(SESSION_FILE)).toBe("0a1b2c3d");
		expect(savedIdOfPath("C:\\Users\\me\\.omp\\agent\\sessions\\x\\2026_9e8d.jsonl")).toBe("9e8d");
		expect(savedIdOfPath("/tmp/notes.txt")).toBeNull();
	});
});
