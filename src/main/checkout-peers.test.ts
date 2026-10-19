/**
 * Which sessions share a checkout (src/main/checkout-peers.ts), on real temp repositories: a worktree's sessions hear
 * each other with their files, another worktree's sessions hear each other as the repository's, a session alone hears
 * nothing, and one that ends up alone is told so once.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { type CheckoutMember, CheckoutPeerCoordinator, readCheckoutPlace } from "./checkout-peers";
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

function member(key: string, cwd: string, files: string[] = [], over: Partial<CheckoutMember> = {}): Fake {
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
			if (method === "checkout_touched") return { files };
			sent.push(params as CheckoutPeers);
			return { ok: true };
		},
		...over,
	};
}

function coordinator(members: () => CheckoutMember[], hidden = new Set<string>()) {
	return new CheckoutPeerCoordinator({
		members,
		place: cwd => readCheckoutPlace(cwd, readOriginFacts),
		hiddenPaths: () => hidden,
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

	it("lists a session hidden from agents without its id or title, and one run for a paired device without an id", async () => {
		const a = member("a", main);
		const secret = member("s", main, [path.join(main, "src/secret.ts")]);
		const hosted = member("h", main, [], { id: null, device: "Galaxy", canMessage: false });
		await coordinator(() => [a, secret, hosted], new Set(["/sessions/s.jsonl"])).refresh();
		expect(a.sent.at(-1)?.worktree).toEqual([
			{ id: null, title: "", files: [path.join(main, "src/secret.ts")] },
			{ id: null, title: "Session h", device: "Galaxy", files: [] },
		]);
		expect(hosted.sent.at(-1)?.canMessage).toBe(false);
	});
});
