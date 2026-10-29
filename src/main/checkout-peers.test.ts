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
import { CheckoutLedger } from "../../resources/gui-bridge/modes/checkout-peers-core";
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
	gitStatus: (toplevel: string, paths: string[]) => Promise<string> = () =>
		Promise.reject(new Error("git is not available")),
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

	it("keeps a claim whose write is still running when a pass finds the file clean", async () => {
		// The ledger never claims under a scratch folder (`/tmp`, `/var/folders`), where the temp repositories live: a worktree of its own.
		const top = "/work/app";
		const host = { realpath: (file: string) => file, isDirectory: () => false };
		const ledger = new CheckoutLedger();
		const writer = member("w", top, [], {
			request: async (method, params) => {
				if (method === "checkout_status") return ledger.claims.status();
				if (method === "checkout_retire") ledger.claims.retireFrom(params);
				return { ok: true };
			},
		});
		const other = member("o", top);
		let listed = porcelain();
		const peers = new CheckoutPeerCoordinator({
			members: () => [writer, other],
			place: async () => ({ toplevel: top, commonDir: `${top}/.git` }),
			hiddenPaths: () => new Set(),
			gitStatus: async () => listed,
		});
		// `sleep 8; echo changed > src/t.ts`: claimed at the hook, the file still clean while main takes a pass.
		ledger.call("bash", { command: "sleep 8; echo changed > src/t.ts" }, top, undefined, host, "c1");
		await peers.refresh();
		expect(other.sent.at(-1)?.worktree[0]?.files).toEqual([`${top}/src/t.ts`]);
		expect(ledger.claims.files).toEqual([`${top}/src/t.ts`]);
		listed = porcelain(" M src/t.ts");
		ledger.settle("c1");
		await peers.refresh();
		expect(other.sent.at(-1)?.worktree[0]?.files).toEqual([`${top}/src/t.ts`]);
		expect(ledger.claims.files).toEqual([`${top}/src/t.ts`]);
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
				worktreeFiles: [src("x.ts", linked), src("z.ts", linked)],
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

describe("checkout peers: what main keeps, asks and waits for", () => {
	afterEach(() => vi.useRealTimers());

	const src = (name: string, top = main) => path.join(top, "src", name);

	interface Scripted extends Fake {
		status: {
			files?: string[];
			stamps?: number[];
			pending?: string[];
			instance?: string;
			task?: string;
		};
		retired: Array<{ instance?: string; files: Array<{ file: string; stamp: number }> }>;
		statusCalls: number;
	}

	/** A member whose bridge answers `status` (changed between passes) and logs the retires and peer lists it is sent. */
	function scripted(key: string, cwd: string, status: Scripted["status"] = {}, over: Partial<CheckoutMember> = {}) {
		const base = member(key, cwd);
		const fake: Scripted = {
			...base,
			status,
			retired: [],
			statusCalls: 0,
			request: async (method, params) => {
				if (method === "checkout_status") {
					fake.statusCalls++;
					return { files: [], stamps: [], pending: [], instance: "i1", ...fake.status };
				}
				if (method === "checkout_retire") {
					fake.retired.push(params as Scripted["retired"][number]);
					return { ok: true };
				}
				fake.sent.push(params as CheckoutPeers);
				return { ok: true };
			},
			...over,
		};
		return fake;
	}

	it("tells every other member of every repository when one omp never answers a send", async () => {
		let hang = false;
		const stuck = scripted(
			"h",
			main,
			{},
			{
				request: async method => {
					if (method === "checkout_status") return { files: [] };
					if (hang) return new Promise<never>(() => undefined);
					return { ok: true };
				},
			},
		);
		const x = scripted("x", main);
		const y1 = scripted("y1", other);
		const y2 = scripted("y2", other);
		const peers = coordinator(() => [stuck, x, y1, y2]);
		await peers.refresh();
		hang = true;
		x.status = { files: [src("x.ts")], stamps: [1] };
		y1.status = { files: [path.join(other, "y.ts")], stamps: [1] };
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pass = peers.refresh();
		await vi.advanceTimersByTimeAsync(5_000);
		await pass;
		expect(y2.sent.at(-1)?.worktree[0]?.files).toEqual([path.join(other, "y.ts")]);
		expect(stuck.id).toBe("h");
		expect(peers.peersOf("h")).toEqual(["x"]);
	});

	it("does not wait for a retire a frozen omp never answers", async () => {
		let hang = false;
		const files = [src("live.ts"), src("gone.ts")];
		const stuck = scripted(
			"h",
			main,
			{},
			{
				request: async method => {
					if (method === "checkout_status") return { files, stamps: [1, 2], pending: [], instance: "i" };
					return hang ? new Promise<never>(() => undefined) : { ok: true };
				},
			},
		);
		const x = scripted("x", main);
		let listed = porcelain(" M src/live.ts", " M src/gone.ts");
		const peers = coordinator(
			() => [stuck, x],
			new Set(),
			async () => listed,
		);
		await peers.refresh();
		hang = true;
		listed = porcelain(" M src/live.ts");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pass = peers.refresh();
		await vi.advanceTimersByTimeAsync(5_000);
		await pass;
		expect(x.sent.at(-1)?.worktree[0]?.files).toEqual([src("live.ts")]);
	});

	it("tells a restarted omp (a new instance) its peers again, and retires only with that instance", async () => {
		const a = scripted("a", main, { files: [src("a.ts")], stamps: [1], instance: "one" });
		const b = scripted("b", main);
		const peers = coordinator(
			() => [a, b],
			new Set(),
			async () => "",
		);
		await peers.refresh();
		expect(a.sent).toHaveLength(1);
		expect(a.retired).toEqual([{ instance: "one", files: [{ file: src("a.ts"), stamp: 1 }] }]);
		await peers.refresh();
		expect(a.sent).toHaveLength(1);
		a.status = { instance: "two" };
		await peers.refresh();
		expect(a.sent).toHaveLength(2);
		expect(a.sent[1]).toEqual(a.sent[0]);
	});

	it("asks git only with claims, and only about the claimed paths", async () => {
		const asked: Array<{ top: string; paths: string[] }> = [];
		const a = scripted("a", main);
		const b = scripted("b", main);
		const peers = coordinator(
			() => [a, b],
			new Set(),
			async (top, paths) => {
				asked.push({ top, paths: [...paths].sort() });
				return "";
			},
		);
		await peers.refresh();
		expect(asked).toEqual([]);
		a.status = { files: [src("a.ts"), path.join(os.tmpdir(), "elsewhere.log")], stamps: [1, 2] };
		b.status = { files: [src("b.ts")], stamps: [1] };
		await peers.refresh();
		expect(asked).toEqual([{ top: main, paths: [path.join("src", "a.ts"), path.join("src", "b.ts")] }]);
	});

	it("drops and retires a claim outside the worktree, never crowds real claims out, and shows all that are held", async () => {
		const scratch = Array.from({ length: 50 }, (_, index) => path.join(os.tmpdir(), `scratch-${index}.log`));
		const real = Array.from({ length: 60 }, (_, index) => src(`f${index}.ts`));
		const b = scripted("b", main, {
			files: [...scratch, ...real],
			stamps: [...scratch.map((_, index) => index + 1), ...real.map((_, index) => 100 + index)],
		});
		const a = scripted("a", main);
		const listed = porcelain(...real.map(file => `?? ${path.relative(main, file).split(path.sep).join("/")}`));
		await coordinator(
			() => [a, b],
			new Set(),
			async () => listed,
		).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual(real);
		expect(b.retired.flatMap(entry => entry.files.map(claim => claim.file)).sort()).toEqual([...scratch].sort());
	});

	it("keeps a claim while git lists anything under it or a path containing it, and retires the rest", async () => {
		const folder = src("old");
		const inSubmodule = path.join(main, "lib", "src", "f.ts");
		const b = scripted("b", main, {
			files: [folder, inSubmodule, src("gone.ts")],
			stamps: [1, 2, 3],
		});
		const a = scripted("a", main);
		await coordinator(
			() => [a, b],
			new Set(),
			async () => porcelain("?? src/old/x.ts", " M lib"),
		).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([folder, inSubmodule]);
		expect(b.retired).toEqual([{ instance: "i1", files: [{ file: src("gone.ts"), stamp: 3 }] }]);
	});

	it("matches a decomposed (NFD) file name against the composed (NFC) one git prints", async () => {
		const nfd = "\u1112\u1161\u11ab.ts";
		const nfc = nfd.normalize("NFC");
		expect(nfd).not.toBe(nfc);
		const b = scripted("b", main, { files: [path.join(main, "src", nfd)], stamps: [1] });
		const a = scripted("a", main);
		await coordinator(
			() => [a, b],
			new Set(),
			async () => porcelain(`?? src/${nfc}`),
		).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([path.join(main, "src", nfd)]);
		expect(b.retired).toEqual([]);
	});

	it("never retires a pending path, and shows one git does not list yet", async () => {
		const b = scripted("b", main, { files: [src("q.ts")], stamps: [1], pending: [src("q.ts"), src("p.ts")] });
		const a = scripted("a", main);
		await coordinator(
			() => [a, b],
			new Set(),
			async () => "",
		).refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("q.ts"), src("p.ts")]);
		expect(b.retired).toEqual([]);
	});

	it("falls back to what the last good listing said when git fails, and keeps no scratch file", async () => {
		const b = scripted("b", main, {
			files: [src("c.ts"), src("d.ts"), path.join(os.tmpdir(), "x.log")],
			stamps: [1, 2, 3],
		});
		const answer = b.request;
		b.request = async (method, params) => {
			if (method === "checkout_retire") throw new Error("busy");
			return answer(method, params);
		};
		const a = scripted("a", main);
		let failing = false;
		const peers = coordinator(
			() => [a, b],
			new Set(),
			async () => {
				if (failing) throw new Error("git timed out");
				return porcelain("?? src/d.ts");
			},
		);
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("d.ts")]);
		failing = true;
		await peers.refresh();
		expect(a.sent.at(-1)?.worktree[0]?.files).toEqual([src("d.ts")]);
	});

	it("runs one pass a quarter second after a burst of checkout_files frames, and none for a session alone", async () => {
		const ownerA = {};
		const ownerD = {};
		const a = scripted("a", main, {}, { owner: ownerA });
		const b = scripted("b", main);
		const d = scripted("d", other, {}, { owner: ownerD });
		const peers = coordinator(() => [a, b, d]);
		await peers.refresh();
		const before = a.statusCalls;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		for (let index = 0; index < 5; index++) peers.filesChanged(ownerA);
		await vi.advanceTimersByTimeAsync(200);
		expect(a.statusCalls).toBe(before);
		await vi.advanceTimersByTimeAsync(100);
		expect(a.statusCalls).toBe(before + 1);
		peers.filesChanged(ownerD);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(a.statusCalls).toBe(before + 1);
	});

	it("asks real git about the claimed paths only, and about a submodule that holds one", async () => {
		const sub = path.join(dir, "sub-src");
		const sup = path.join(dir, "sup");
		for (const repo of [sub, sup]) {
			fs.mkdirSync(repo);
			git(repo, "init", "-q", "-b", "main");
		}
		fs.mkdirSync(path.join(sub, "src"));
		fs.writeFileSync(path.join(sub, "src", "f.ts"), "a\n");
		git(sub, "add", ".");
		git(sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i");
		git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "lib");
		git(sup, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "s");
		fs.appendFileSync(path.join(sup, "lib", "src", "f.ts"), "b\n");
		fs.writeFileSync(path.join(sup, "one.ts"), "1\n");
		fs.writeFileSync(path.join(sup, "two.ts"), "2\n");
		const top = fs.realpathSync.native(sup);
		const listed = (text: string) =>
			text
				.split("\0")
				.filter(Boolean)
				.map(entry => entry.slice(3))
				.sort();
		expect(listed(await readGitStatus(top, ["one.ts"]))).toEqual(["one.ts"]);
		expect(listed(await readGitStatus(top, ["one.ts", path.join("lib", "src", "f.ts")]))).toEqual(["lib", "one.ts"]);
		expect(listed(await readGitStatus(top, ["*.ts"]))).toEqual([]);
	});
});
