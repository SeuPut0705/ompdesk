/**
 * Sessions sharing a checkout, round 3: the lifecycle of a session's claims (checkout-peers-core.ts `CheckoutLedger`,
 * modes/checkout-peers.ts). Each case names the report finding it pins (LedgerLifecycle 1-16, MainAndWire 3, 7, 9,
 * GuardRules 9, 10, 17).
 */
import { describe, expect, it, vi } from "vitest";
import { isInside } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import type { CheckoutPeer, CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import {
	type CallVerdict,
	CheckoutLedger,
	overlapNotice,
	reportedFiles,
} from "../../resources/gui-bridge/modes/checkout-peers-core";

const REPO = "/work/app";
const OTHER = "/work/wt/app-feature";
const file = (name: string) => `${REPO}/${name}`;
const peer = (over: Partial<CheckoutPeer> = {}): CheckoutPeer => ({ id: "tab-b", title: "Rename helper", ...over });
const alone: CheckoutPeers = { toplevel: REPO, commonDir: `${REPO}/.git`, worktree: [], repo: [], canMessage: true };
const sharing: CheckoutPeers = { ...alone, worktree: [peer({ files: [file("src/b.ts")] })] };
const host = { realpath: (path: string) => path, isDirectory: (path: string) => path === file("src") };
const notice = (verdict: CallVerdict) => ("notice" in verdict ? verdict.notice : undefined);
const blocked = (verdict: CallVerdict) => "block" in verdict;
const bash = (ledger: CheckoutLedger, command: string, peers?: CheckoutPeers, id?: string, owner = "") =>
	ledger.call("bash", { command }, REPO, peers, host, id, owner);

describe("LedgerLifecycle 1 and GuardRules 1: a file both sessions changed", () => {
	it("is taken by name by either session, so neither is stuck holding it", () => {
		const mine = new CheckoutLedger();
		mine.call("edit", { path: "src/b.ts" }, REPO, sharing, host);
		expect(blocked(bash(mine, "git add -- src/b.ts && git commit -m done -- src/b.ts", sharing))).toBe(false);
		const theirs: CheckoutPeers = {
			...alone,
			worktree: [peer({ files: [file("src/b.ts")], shared: [file("src/b.ts")] })],
		};
		expect(blocked(bash(mine, "git restore src/b.ts", theirs))).toBe(true);
	});
});

describe("LedgerLifecycle 2: a commit, restore or checkout makes the files it names clean at once", () => {
	it("drops the named own claims when the call succeeds, and keeps them when it fails", () => {
		const ledger = new CheckoutLedger();
		for (const name of ["a", "c"]) ledger.call("edit", { path: `src/${name}.ts` }, REPO, undefined, host);
		bash(ledger, "git commit -m x -- src/a.ts", undefined, "k1");
		expect(ledger.settle("k1", "", { isError: false })).toBe(true);
		expect(ledger.claims.files).toEqual([file("src/c.ts")]);
		bash(ledger, "git commit -m x -- src/c.ts", undefined, "k2");
		ledger.settle("k2", "", { isError: true });
		expect(ledger.claims.files).toEqual([file("src/c.ts")]);
	});

	it("keeps a file changed by a later call", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		bash(ledger, "git commit -m x -- src/a.ts", undefined, "k1");
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host, "e1");
		ledger.settle("k1", "", { isError: false });
		expect(ledger.claims.files).toEqual([file("src/a.ts")]);
	});

	it("drops the files of a restore, a checkout of paths and a stash of paths, and asks main to read", () => {
		for (const command of ["git restore src/a.ts", "git checkout -- src/a.ts", "git commit -qm x src/a.ts"]) {
			const ledger = new CheckoutLedger();
			ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
			bash(ledger, command, undefined, "k");
			expect(ledger.settle("k"), command).toBe(true);
			expect(ledger.claims.files, command).toEqual([]);
		}
	});
});

describe("LedgerLifecycle 4, MainAndWire 3 and 9: the claims survive the omp, an instance tells main which load answered", () => {
	it("restores the journal's claims and counts them as a fresh load's", () => {
		const first = new CheckoutLedger();
		first.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		first.call("edit", { path: "src/c.ts" }, REPO, undefined, host);
		const second = new CheckoutLedger();
		second.claims.restore({ ...first.claims.snapshot(), at: 1 });
		expect(second.claims.files).toEqual(first.claims.files);
		expect(second.claims.status().files).toEqual(first.claims.files);
		expect(second.claims.instance).not.toBe(first.claims.instance);
		// Later edits get stamps above every restored one.
		second.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		expect(second.claims.stamp(file("src/a.ts"))).toBeGreaterThan(second.claims.stamp(file("src/c.ts")));
	});

	it("replaces the claims on a session switch, and takes none from malformed data", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		ledger.claims.restore({ files: [file("src/x.ts")] });
		expect(ledger.claims.files).toEqual([file("src/x.ts")]);
		ledger.claims.restore(undefined);
		expect(ledger.claims.files).toEqual([]);
		ledger.claims.restore({ files: [1, null, "", file("src/y.ts")] });
		expect(ledger.claims.files).toEqual([file("src/y.ts")]);
	});

	it("ignores a retire read from another load, and drops a pending path from none", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		const seen = [{ file: file("src/a.ts"), stamp: ledger.claims.stamp(file("src/a.ts")) }];
		expect(ledger.claims.retireFrom({ instance: "another omp", files: seen })).toBe(false);
		expect(ledger.claims.files).toEqual([file("src/a.ts")]);
		expect(ledger.claims.retireFrom({ files: seen })).toBe(false);
		expect(ledger.claims.retireFrom({ instance: ledger.claims.instance, files: seen })).toBe(true);
		expect(ledger.claims.files).toEqual([]);
	});

	it("reports every claim without a cap, and the paths a running call still writes", () => {
		const ledger = new CheckoutLedger();
		for (let n = 0; n < 75; n++) ledger.call("edit", { path: `src/f${n}.ts` }, REPO, undefined, host);
		bash(ledger, "sleep 9; echo x > gen.ts", undefined, "running");
		const status = ledger.claims.status();
		expect(status.files).toHaveLength(76);
		expect(status.stamps).toHaveLength(76);
		expect(status.pending).toEqual([file("gen.ts")]);
		expect(status.instance).toBe(ledger.claims.instance);
		ledger.claims.retire([{ file: file("gen.ts"), stamp: ledger.claims.stamp(file("gen.ts")) }]);
		expect(ledger.claims.files).toContain(file("gen.ts"));
	});

	it("moves its revision only when the set of claimed files changes", () => {
		const ledger = new CheckoutLedger();
		const start = ledger.claims.revision;
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		const added = ledger.claims.revision;
		expect(added).toBeGreaterThan(start);
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host);
		expect(ledger.claims.revision).toBe(added);
	});
});

describe("LedgerLifecycle 5: a call that wrote nothing gives its claim back", () => {
	it("restores the earlier claim when a file tool fails, and removes a claim that had no earlier one", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host, "ok");
		ledger.settle("ok");
		const before = ledger.claims.stamp(file("src/a.ts"));
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host, "fails");
		ledger.call("edit", { path: "src/new.ts" }, REPO, undefined, host, "fails-too");
		expect(ledger.claims.stamp(file("src/a.ts"))).toBeGreaterThan(before);
		expect(ledger.settle("fails", "", { isError: true })).toBe(true);
		expect(ledger.claims.stamp(file("src/a.ts"))).toBe(before);
		ledger.settle("fails-too", "", { isError: true });
		expect(ledger.claims.files).toEqual([file("src/a.ts")]);
	});

	it("drops the claim of a file tool that never reported (denied, blocked after the hook) at the end of the run, and keeps a script's", () => {
		const ledger = new CheckoutLedger();
		ledger.call("write", { path: "src/denied.ts", content: "x" }, REPO, undefined, host, "w", "main");
		bash(ledger, "sed -i s/a/b/ src/script.ts", undefined, "s", "main");
		expect(ledger.settleAll("main")).toBe(true);
		expect(ledger.claims.files).toEqual([file("src/script.ts")]);
	});

	it("keeps the claims of a script that failed, because it may have written", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, "echo x > src/gen.ts && false", undefined, "s");
		ledger.settle("s", "", { isError: true });
		expect(ledger.claims.files).toEqual([file("src/gen.ts")]);
	});

	it("does not let a later call's claim vanish with an earlier one's failure", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host, "first");
		ledger.call("edit", { path: "src/a.ts" }, REPO, undefined, host, "second");
		ledger.settle("first", "", { isError: true });
		expect(ledger.claims.files).toEqual([file("src/a.ts")]);
	});
});

describe("LedgerLifecycle 9 and MainAndWire (D6): a backgrounded command keeps its claim until the job ends", () => {
	it("stays pending under its job, and settles when the job's end is seen", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, "bun run gen > src/gen.ts", undefined, "c1");
		expect(ledger.settle("c1", "", { isError: false, job: "bg_1" })).toBe(true);
		ledger.claims.retire([{ file: file("src/gen.ts"), stamp: ledger.claims.stamp(file("src/gen.ts")) }]);
		expect(ledger.claims.files).toEqual([file("src/gen.ts")]);
		expect(ledger.claims.status().pending).toEqual([file("src/gen.ts")]);
		expect(ledger.claims.settleJob("bg_1")).toBe(true);
		expect(ledger.claims.status().pending).toEqual([]);
		ledger.claims.retire([{ file: file("src/gen.ts"), stamp: ledger.claims.stamp(file("src/gen.ts")) }]);
		expect(ledger.claims.files).toEqual([]);
	});

	it("settles the jobs of an agent that are no longer running, and no other agent's", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, "echo 1 > one.ts", undefined, "a", "main");
		bash(ledger, "echo 2 > two.ts", undefined, "b", "Scout");
		ledger.settle("a", "main", { isError: false, job: "j1" });
		ledger.settle("b", "Scout", { isError: false, job: "j2" });
		expect(ledger.claims.reconcileJobs(new Set(), "main")).toBe(true);
		expect(ledger.claims.status().pending).toEqual([file("two.ts")]);
		expect(ledger.claims.reconcileJobs(new Set(["j2"]))).toBe(false);
		expect(ledger.claims.reconcileJobs(new Set())).toBe(true);
	});
});

describe("LedgerLifecycle 10 and GuardRules 8: what a result reports, folders and globs", () => {
	it("claims nothing for an ast_edit preview, and the files its applied result names", () => {
		const ledger = new CheckoutLedger();
		ledger.call("ast_edit", { paths: ["src/c.ts"], ops: [] }, REPO, undefined, host, "p");
		expect(ledger.claims.files).toEqual([]);
		ledger.settle("p", "", { isError: false });
		ledger.call("write", { path: "xd://resolve", content: "apply" }, REPO, undefined, host, "r");
		const details = { xdev: { inner: { sourceResultDetails: { applied: true, files: ["src/c.ts", "src/d.ts"] } } } };
		expect(ledger.settle("r", "", { isError: false, reported: reportedFiles("write", details, "") })).toBe(true);
		expect([...ledger.claims.files].sort()).toEqual([file("src/c.ts"), file("src/d.ts")]);
	});

	it("reads the files an lsp rename applied from its result text", () => {
		const text =
			"Applied rename:\n  Applied 2 edit(s) to src/a.ts\n  Applied 1 edit(s) to src/lib/x.ts\n  Renamed src/o.ts → src/n.ts";
		expect(reportedFiles("lsp", undefined, text)).toEqual(["src/a.ts", "src/lib/x.ts", "src/o.ts", "src/n.ts"]);
		const ledger = new CheckoutLedger();
		ledger.call(
			"lsp",
			{ action: "rename", file: "src/a.ts", symbol: "x", new_name: "y" },
			REPO,
			undefined,
			host,
			"l",
		);
		ledger.settle("l", "", { isError: false, reported: reportedFiles("lsp", undefined, text) });
		expect(ledger.claims.files).toHaveLength(4);
		expect(ledger.claims.files).toContain(file("src/lib/x.ts"));
	});

	it("reads nothing from a failed result", () => {
		const ledger = new CheckoutLedger();
		ledger.call("write", { path: "xd://resolve" }, REPO, undefined, host, "r");
		ledger.settle("r", "", { isError: true, reported: ["src/c.ts"] });
		expect(ledger.claims.files).toEqual([]);
	});

	it("claims a folder a command removes (main keeps it while git lists anything below) and never a glob", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, "rm -rf src/old && cp -r /tmp/x/ src/ && echo y > 'src/*.ts'", undefined);
		expect(ledger.claims.files).toContain(file("src/old"));
		expect(ledger.claims.files.some(path => path.includes("*"))).toBe(false);
		const globbed = new CheckoutLedger();
		bash(globbed, "rm src/*.ts", undefined);
		expect(globbed.claims.files).toEqual([]);
	});
});

describe("LedgerLifecycle 11: files git itself changes", () => {
	it("claims both names of a git mv, the paths of a git rm, and a checkout of a revision's paths", () => {
		const claims = (command: string) => {
			const ledger = new CheckoutLedger();
			bash(ledger, command, undefined);
			return [...ledger.claims.files].sort();
		};
		expect(claims("git mv src/a.ts src/z.ts")).toEqual([file("src/a.ts"), file("src/z.ts")]);
		expect(claims("git mv lib/a.ts src")).toEqual([file("lib/a.ts"), file("src/a.ts")]);
		expect(claims("git rm src/a.ts src/c.ts")).toEqual([file("src/a.ts"), file("src/c.ts")]);
		expect(claims("git rm --cached src/a.ts")).toEqual([]);
		expect(claims("git checkout HEAD~1 -- src/a.ts")).toEqual([file("src/a.ts")]);
		expect(claims("git restore --source=HEAD~1 src/a.ts")).toEqual([file("src/a.ts")]);
		expect(claims("git restore -s HEAD~1 src/a.ts")).toEqual([file("src/a.ts")]);
		expect(claims("git restore --staged src/a.ts")).toEqual([]);
		expect(claims("git status")).toEqual([]);
	});
});

describe("GuardRules 9: the notice a failed call carried is said again", () => {
	const overlapping: CheckoutPeers = {
		...alone,
		worktree: [peer({ files: [file("src/b.ts")], shared: [file("src/b.ts")] })],
	};

	it("puts the told pairs back when the call that carried them errored", () => {
		const ledger = new CheckoutLedger();
		const first = bash(ledger, "bun test", overlapping, "t1");
		expect(notice(first)).toContain("src/b.ts");
		ledger.settle("t1", "", { isError: true });
		expect(notice(bash(ledger, "git status", overlapping, "t2"))).toContain("src/b.ts");
		ledger.settle("t2", "", { isError: false });
		expect(notice(bash(ledger, "git status", overlapping, "t3"))).toBeUndefined();
	});

	it("also when the call never reported back (denied, blocked later)", () => {
		const ledger = new CheckoutLedger();
		expect(notice(ledger.call("read", {}, REPO, overlapping, host, "t1", "main"))).toContain("src/b.ts");
		ledger.settleAll("main");
		expect(notice(ledger.call("read", {}, REPO, overlapping, host, "t2", "main"))).toContain("src/b.ts");
	});

	it("says an edit's overlap again when the edit failed", () => {
		const ledger = new CheckoutLedger();
		const edited = ledger.call("edit", { path: "src/b.ts" }, REPO, sharing, host, "e1");
		expect(notice(edited)).toContain("Another session changed a file you just edited");
		ledger.settle("e1", "", { isError: true });
		expect(notice(ledger.call("edit", { path: "src/b.ts" }, REPO, sharing, host, "e2"))).toContain(
			"Another session changed a file you just edited",
		);
		ledger.settle("e2", "", { isError: true });
		expect(ledger.claims.files).toEqual([]);
	});

	it("keeps what it said when a call saw no peers for a moment (GuardRules 17)", () => {
		const ledger = new CheckoutLedger();
		const said = overlapNotice([], overlapping, new Set());
		expect(said.text).toBeDefined();
		ledger.call("read", {}, REPO, overlapping, host);
		ledger.call("read", {}, REPO, undefined, host);
		expect(notice(ledger.call("read", {}, REPO, overlapping, host))).toBeUndefined();
	});
});

describe("GuardRules 10 and LedgerLifecycle 16: what is no claim, and how many are kept", () => {
	it("never records scratch output or a path outside the worktree, so they cannot push a real claim out", () => {
		const ledger = new CheckoutLedger();
		ledger.call("edit", { path: "src/a.ts" }, REPO, sharing, host);
		for (let n = 0; n < 60; n++)
			bash(ledger, `bun test > /tmp/run-${n}.log 2>&1; echo x > /private/tmp/x${n}`, sharing);
		bash(ledger, `echo x > ${OTHER}/src/y.ts; echo x > ~/notes.md`, sharing);
		expect(ledger.claims.files).toEqual([file("src/a.ts")]);
	});

	it("claims files of a checkout that itself sits under a scratch prefix (macOS temp folders)", () => {
		const root = "/private/var/folders/xy/T/checkout-peers-1/app";
		const there: CheckoutPeers = { ...alone, toplevel: root, worktree: [peer({ files: [`${root}/src/b.ts`] })] };
		const ledger = new CheckoutLedger();
		ledger.call("bash", { command: "echo x > src/a.ts; echo y > /tmp/out.log" }, root, there, host);
		ledger.call("edit", { path: "src/c.ts" }, root, undefined, host);
		expect(ledger.claims.files).toEqual([`${root}/src/c.ts`, `${root}/src/a.ts`]);
	});

	it("claims the files a shell glob matches when the command runs, never the glob itself", () => {
		const matching = {
			...host,
			expand: (glob: string) => (glob === file("src/*.ts") ? [file("src/a.ts"), file("src/b.ts")] : []),
		};
		const ledger = new CheckoutLedger();
		ledger.call("bash", { command: "rm src/*.ts && rm lib/*.js" }, REPO, undefined, matching);
		expect(ledger.claims.files).toEqual([file("src/a.ts"), file("src/b.ts")]);
	});

	it("holds more than forty real claims", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, Array.from({ length: 60 }, (_, n) => `echo x > src/f${n}.ts`).join(" && "), sharing);
		expect(ledger.claims.files).toHaveLength(60);
	});

	it("folds case only where the file system does", () => {
		expect(isInside("/work/app/Src/A.ts", "/work/app/src", "darwin")).toBe(true);
		expect(isInside("/work/app/Src/A.ts", "/work/app/src", "win32")).toBe(true);
		expect(isInside("/work/app/Src/A.ts", "/work/app/src", "linux")).toBe(false);
		expect(isInside("/work/app/src/a.ts", "/work/app/src", "linux")).toBe(true);
	});

	it("keys a call by its owner as well as its id, so another agent's result settles nothing of it", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, "sleep 8; echo x > gen.ts", undefined, "call_1", "main");
		bash(ledger, "echo y > other.ts", undefined, "call_1", "Scout");
		expect(ledger.settle("call_1", "Scout", { isError: false })).toBe(true);
		ledger.claims.retire([{ file: file("gen.ts"), stamp: ledger.claims.stamp(file("gen.ts")) }]);
		expect(ledger.claims.files).toContain(file("gen.ts"));
		expect(ledger.settle("call_1", "main", { isError: false })).toBe(true);
	});
});

describe("modes/checkout-peers.ts: the hooks and the journal", () => {
	type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

	/** What this test uses of the hook module. */
	interface HookModule {
		install(pi: unknown): void;
		methods: Record<string, (params: unknown, env: never) => Promise<unknown>>;
	}

	async function load() {
		vi.resetModules();
		// A specifier tsc does not follow: the module's stock imports resolve only inside omp, not in this typecheck.
		const hooks = "../../resources/gui-bridge/modes/checkout-peers";
		const { install, methods }: HookModule = await import(hooks);
		const handlers = new Map<string, Handler[]>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		};
		install(pi);
		const fire = async (name: string, event: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
			return result;
		};
		const frames: unknown[] = [];
		const session = { sessionManager: { getBranch: () => [] as unknown[] }, getAsyncJobTree: () => null };
		const env = {
			pi: { pi: { VERSION: "0" } },
			session: () => session,
			emit: (event: unknown) => frames.push(event),
		};
		const shared: { bindEnv(env: unknown): void } = await import(`${hooks.slice(0, hooks.lastIndexOf("/"))}/shared`);
		shared.bindEnv(env);
		return { methods, fire, entries, env, frames };
	}

	const ctx = (branch: unknown[] = []) => ({
		cwd: REPO,
		sessionManager: { getBranch: () => branch },
		getAsyncJobSnapshot: () => ({ running: [] }),
	});

	it("writes the claims to the journal at the end of a run and restores them in a new load", async () => {
		const first = await load();
		await first.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "src/a.ts" } }, ctx());
		await first.fire("tool_result", { toolName: "edit", toolCallId: "e1", isError: false, content: [] }, ctx());
		await first.fire("agent_end", {}, ctx());
		const entry = first.entries.at(-1);
		expect(entry?.type).toBe("ompdesk.checkout-claims");
		expect(entry?.data).toMatchObject({ files: [file("src/a.ts")] });

		const second = await load();
		await second.fire(
			"session_start",
			{},
			ctx([{ type: "custom", customType: "ompdesk.checkout-claims", data: entry?.data }]),
		);
		const status = (await second.methods.checkout_status({}, second.env as never)) as {
			files: string[];
			instance: string;
		};
		expect(status.files).toEqual([file("src/a.ts")]);
		expect(status.instance).toEqual(expect.any(String));
		expect(second.frames).toContainEqual({ type: "checkout_files" });
		// A switch to a session without an entry takes the new session's claims, which are none.
		await second.fire("session_switch", {}, ctx([]));
		const after = (await second.methods.checkout_status({}, second.env as never)) as { files: string[] };
		expect(after.files).toEqual([]);
	});

	it("keeps a backgrounded bash call pending until its job's update says it ended", async () => {
		const loaded = await load();
		await loaded.fire(
			"tool_call",
			{ toolName: "bash", toolCallId: "b1", input: { command: "bun run gen > src/gen.ts" } },
			ctx(),
		);
		await loaded.fire(
			"tool_result",
			{
				toolName: "bash",
				toolCallId: "b1",
				isError: false,
				content: [],
				details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
			},
			ctx(),
		);
		const running = (await loaded.methods.checkout_status({}, loaded.env as never)) as { pending: string[] };
		expect(running.pending).toEqual([file("src/gen.ts")]);
		await loaded.fire("tool_execution_update", {
			toolCallId: "b1",
			partialResult: { details: { async: { state: "completed", jobId: "bg_1", type: "bash" } } },
		});
		const done = (await loaded.methods.checkout_status({}, loaded.env as never)) as { pending: string[] };
		expect(done.pending).toEqual([]);
	});

	it("answers a retire only from its own load", async () => {
		const loaded = await load();
		await loaded.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "src/a.ts" } }, ctx());
		await loaded.fire("tool_result", { toolName: "edit", toolCallId: "e1", isError: false, content: [] }, ctx());
		const status = (await loaded.methods.checkout_status({}, loaded.env as never)) as {
			files: string[];
			stamps: number[];
			instance: string;
		};
		const files = [{ file: status.files[0], stamp: status.stamps[0] }];
		await loaded.methods.checkout_retire({ instance: "old", files }, loaded.env as never);
		expect(
			((await loaded.methods.checkout_status({}, loaded.env as never)) as { files: string[] }).files,
		).toHaveLength(1);
		await loaded.methods.checkout_retire({ instance: status.instance, files }, loaded.env as never);
		expect(
			((await loaded.methods.checkout_status({}, loaded.env as never)) as { files: string[] }).files,
		).toHaveLength(0);
	});
});
