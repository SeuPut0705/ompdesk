/**
 * Which sessions share a checkout (src/main/checkout-peers.ts), on real temp repositories: a worktree's sessions hear
 * each other with their files, another worktree's sessions hear each other as the repository's, a session alone hears
 * nothing, and one that ends up alone is told so once. A file is a claim only while git lists it as uncommitted.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { type CheckoutMember, CheckoutPeerCoordinator, readCheckoutPlace, readGitStatus } from "./checkout-peers";
import { readOriginFacts } from "./local/git/origin";

let dir: string;
let main: string;
let linked: string;
let other: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

beforeAll(() => {
	// Native realpath, as the coordinator's: Windows runners spell the temp dir with an 8.3 name the JS one keeps.
	dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "checkout-peers-")));
	main = path.join(dir, "app");
	linked = path.join(dir, "app-feature");
	other = path.join(dir, "other");
	for (const repo of [main, other]) {
		fs.mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	}
	git(main, "worktree", "add", "-q", "-b", "feature", linked);
	fs.mkdirSync(path.join(main, "src"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Fake extends CheckoutMember {
	sent: CheckoutPeers[];
}

function member(
	key: string,
	cwd: string,
	files: string[] = [],
	over: Partial<CheckoutMember> = {},
	task?: string,
): Fake {
	const sent: CheckoutPeers[] = [];
	return {
		key,
		id: key,
		title: `Session ${key}`,
		cwd,
		canMessage: true,
		sessionPath: `/sessions/${key}.jsonl`,
		sent,
		request: async (method, params) => {
			if (method === "checkout_status") return { files, ...(task ? { task } : {}) };
			sent.push(params as CheckoutPeers);
			return { ok: true };
		},
		...over,
	};
}

/** `git status --porcelain=v1 -z` of the given entries (`"?? a.ts"`, `"R  new.ts\0old.ts"`). */
const porcelain = (...entries: string[]) => entries.map(entry => `${entry}\0`).join("");

function coordinator(
	members: () => CheckoutMember[],
	hidden = new Set<string>(),
	gitStatus: (toplevel: string) => Promise<string> = () => Promise.reject(new Error("git is not available")),
) {
	return new CheckoutPeerCoordinator({
		members,
		place: cwd => readCheckoutPlace(cwd, readOriginFacts),
		hiddenPaths: () => hidden,
		gitStatus,
	});
}

describe("checkout peers", () => {
	it("tells sessions in one worktree about each other with their files, and another worktree's as the repository's", async () => {
		const a = member("a", main, [path.join(main, "src/a.ts")]);
		const b = member("b", path.join(main, "src"), [path.join(main, "src/b.ts")]);
		const c = member("c", linked);
		const d = member("d", other);
		const peers = coordinator(() => [a, b, c, d]);
		await peers.refresh();
		expect(a.sent.at(-1)).toMatchObject({
			toplevel: main,
			worktree: [{ id: "b", title: "Session b", files: [path.join(main, "src/b.ts")] }],
			repo: [{ id: "c", worktree: linked }],
			canMessage: true,
		});
		expect(c.sent.at(-1)).toMatchObject({ toplevel: linked, worktree: [], repo: [{ id: "a" }, { id: "b" }] });
		expect(d.sent).toEqual([]);
		expect(peers.peersOf("a")).toEqual(["b", "c"]);
		expect(peers.peersOf("d")).toEqual([]);
	});

	it("gives each peer its task and a same-worktree peer the files both changed; a hidden session has no task", async () => {
		const both = path.join(main, "src/both.ts");
		const a = member("a", main, [both, path.join(main, "src/a.ts")], {}, "Fix the parser");
		const b = member("b", main, [both, path.join(main, "src/b.ts")], {}, "Rename helper");
		const s = member("s", main, [], {}, "Secret work");
		const c = member("c", linked, [], {}, "Release notes");
		await coordinator(() => [a, b, s, c], new Set(["/sessions/s.jsonl"])).refresh();
		const seenByA = a.sent.at(-1);
		expect(seenByA?.worktree[0]).toMatchObject({ id: "b", task: "Rename helper", shared: [both] });
		expect(seenByA?.worktree[1]).toEqual({ id: null, title: "", files: [] });
		expect(seenByA?.repo[0]).toMatchObject({ id: "c" });
		expect(seenByA?.repo[0]?.shared).toBeUndefined();
		expect(b.sent.at(-1)?.worktree[0]).toMatchObject({ id: "a", task: "Fix the parser", shared: [both] });
		expect(c.sent.at(-1)?.repo[0]).toMatchObject({ id: "a", task: "Fix the parser" });
	});

	it("sends only a change, and tells a session left alone once", async () => {
		const a = member("a", main);
		const b = member("b", main);
		let members: CheckoutMember[] = [a, b];
		const peers = coordinator(() => members);
		await peers.refresh();
		await peers.refresh();
		expect(a.sent).toHaveLength(1);
		members = [a];
		await peers.refresh();
		await peers.refresh();
		expect(a.sent).toHaveLength(2);
		expect(a.sent[1]).toMatchObject({ worktree: [], repo: [] });
	});

	it("lists a session hidden from agents without its id, title or file, and one run for a paired device without an id", async () => {
		const a = member("a", main);
		const secret = member("s", main, [path.join(main, "src/secret.ts")]);
		const hosted = member("h", main, [], { id: null, device: "Galaxy", canMessage: false });
		await coordinator(() => [a, secret, hosted], new Set(["/sessions/s.jsonl"])).refresh();
		// The board opens a peer by its file; a hidden session's file is never named.
		expect(a.sent.at(-1)?.worktree).toEqual([
			{ id: null, title: "", files: [path.join(main, "src/secret.ts")] },
			{ id: null, title: "Session h", device: "Galaxy", sessionPath: "/sessions/h.jsonl", files: [] },
		]);
		expect(hosted.sent.at(-1)?.canMessage).toBe(false);
	});
});

describe("checkout peers: a committed file is no longer a claim", () => {
	afterEach(() => vi.useRealTimers());

	const src = (name: string, top = main) => path.join(top, "src", name);

	it("drops a file git no longer lists, from the peer's files and from what both changed, and says it again once it is dirty again", async () => {
		const a = member("a", main, [src("both.ts"), src("a.ts")]);
		const b = member("b", main, [src("both.ts"), src("b.ts")]);
		let listed = porcelain("?? src/a.ts", " M src/b.ts");
		const peers = coordinator(
			() => [a, b],
			new Set(),
			async () => listed,
		);
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]).toMatchObject({ id: "b", files: [src("b.ts")] });
		expect(a.sent.at(-1)?.worktree[0]?.shared).toBeUndefined();
		expect(b.sent.at(-1)?.worktree[0]).toMatchObject({ id: "a", files: [src("a.ts")] });

		listed = porcelain("?? src/a.ts", " M src/b.ts", " M src/both.ts");
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]).toMatchObject({
			files: [src("both.ts"), src("b.ts")],
			shared: [src("both.ts")],
		});
	});

	it("keeps every file when git cannot say", async () => {
		const a = member("a", main, [src("a.ts")]);
		const b = member("b", main, [src("b.ts"), src("c.ts")]);
		await coordinator(() => [a, b]).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("b.ts"), src("c.ts")]);
	});

	it("keeps a deleted file and both names of a rename", async () => {
		const a = member("a", main);
		const b = member("b", main, [src("new.ts"), src("old.ts"), src("gone.ts"), src("committed.ts")]);
		await coordinator(
			() => [a, b],
			new Set(),
			async () => porcelain("R  src/new.ts\0src/old.ts", " D src/gone.ts"),
		).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("new.ts"), src("old.ts"), src("gone.ts")]);
	});

	it("reads the real git status of the worktree", async () => {
		const repo = path.join(dir, "real");
		fs.mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(repo, "committed.ts"), "x\n");
		git(repo, "add", ".");
		git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
		fs.writeFileSync(path.join(repo, "fresh.ts"), "y\n");
		const top = fs.realpathSync.native(repo);
		const a = member("a", top);
		const b = member("b", top, [path.join(top, "committed.ts"), path.join(top, "fresh.ts")]);
		await coordinator(() => [a, b], new Set(), readGitStatus).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([path.join(top, "fresh.ts")]);
	});

	/** A member whose files carry the edit stamps its bridge's ledger gives them, and which retires what main says. */
	function ledgerMember(key: string, cwd: string) {
		const claims = new Map<string, number>();
		let seq = 0;
		const fake = member(key, cwd, [], {
			request: async (method, params) => {
				if (method === "checkout_status") return { files: [...claims.keys()], stamps: [...claims.values()] };
				if (method === "checkout_retire") {
					for (const { file, stamp } of (params as { files: { file: string; stamp: number }[] }).files)
						if (claims.get(file) === stamp) claims.delete(file);
					return { ok: true };
				}
				fake.sent.push(params as CheckoutPeers);
				return { ok: true };
			},
		});
		return { fake, edit: (file: string) => claims.set(file, ++seq) };
	}

	it("never brings back a committed claim when another session changes that file later", async () => {
		const a = ledgerMember("a", main);
		const b = ledgerMember("b", main);
		let listed = porcelain(" M src/f.ts");
		const peers = coordinator(
			() => [a.fake, b.fake],
			new Set(),
			async () => listed,
		);
		a.edit(src("f.ts"));
		await peers.refresh();
		expect(b.fake.sent.at(-1)?.worktree[0]?.files).toEqual([src("f.ts")]);
		// A commits f: clean. Then B changes f: dirty again, and it is B's, never A's.
		listed = porcelain();
		await peers.refresh();
		b.edit(src("f.ts"));
		listed = porcelain(" M src/f.ts");
		await peers.refresh();
		expect(b.fake.sent.at(-1)?.worktree[0]?.files).toEqual([]);
		expect(a.fake.sent.at(-1)?.worktree[0]?.files).toEqual([src("f.ts")]);
		// A changing it again claims it anew.
		a.edit(src("f.ts"));
		await peers.refresh();
		expect(b.fake.sent.at(-1)?.worktree[0]).toMatchObject({ files: [src("f.ts")], shared: [src("f.ts")] });
	});

	it("keeps a member's last answer when its bridge fails or does not answer in time", async () => {
		let files = [src("b.ts")];
		let mode: "answer" | "fail" | "hang" = "answer";
		const a = member("a", main);
		const b = member("b", main, [], {
			request: async (method, params) => {
				if (method !== "checkout_status") return { ok: true, params };
				if (mode === "fail") throw new Error("busy");
				if (mode === "hang") return new Promise<never>(() => undefined);
				return { files, task: "Refactor" };
			},
		});
		const peers = coordinator(() => [a, b]);
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]).toMatchObject({ files: [src("b.ts")], task: "Refactor" });

		mode = "fail";
		files = [];
		await peers.refresh();
		expect(a.sent).toHaveLength(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mode = "hang";
		const pass = peers.refresh();
		await vi.advanceTimersByTimeAsync(3_000);
		await pass;
		expect(a.sent).toHaveLength(1);

		mode = "answer";
		vi.useRealTimers();
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]).toMatchObject({ files: [] });
	});

	it("forgets a member that left: it starts over with no files when it comes back", async () => {
		const a = member("a", main);
		let failing = false;
		const b = member("b", main, [src("b.ts")], {
			request: async (method, params) => {
				if (method !== "checkout_status") return { ok: true, params };
				if (failing) throw new Error("busy");
				return { files: [src("b.ts")] };
			},
		});
		let members: CheckoutMember[] = [a, b];
		const peers = coordinator(() => members);
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("b.ts")]);
		members = [a];
		await peers.refresh();
		members = [a, b];
		failing = true;
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([]);
	});

	it("tells another worktree's session the files of its peer in its own paths, and what both changed", async () => {
		const a = member("a", main, [src("x.ts"), src("y.ts")]);
		const c = member("c", linked, [src("x.ts", linked), src("z.ts", linked)]);
		const lists: Record<string, string> = {
			[main]: porcelain("?? src/x.ts", "?? src/y.ts"),
			[linked]: porcelain("?? src/x.ts", "?? src/z.ts"),
		};
		await coordinator(
			() => [a, c],
			new Set(),
			async top => lists[top] ?? "",
		).refresh();
		expect(a.sent.at(-1)?.repo).toEqual([
			{
				id: "c",
				title: "Session c",
				sessionPath: "/sessions/c.jsonl",
				worktree: linked,
				files: [src("x.ts"), src("z.ts")],
				shared: [src("x.ts")],
			},
		]);
		expect(c.sent.at(-1)?.repo[0]).toMatchObject({
			id: "a",
			worktree: main,
			files: [src("x.ts", linked), src("y.ts", linked)],
			shared: [src("x.ts", linked)],
		});
	});

	it("never sends a hidden session's worktree, only the files translated into the receiver's paths", async () => {
		const a = member("a", main, [src("x.ts")]);
		const secret = member("s", linked, [src("x.ts", linked)]);
		await coordinator(() => [a, secret], new Set(["/sessions/s.jsonl"])).refresh();
		expect(a.sent.at(-1)?.repo).toEqual([{ id: null, title: "", files: [src("x.ts")], shared: [src("x.ts")] }]);
	});
});
