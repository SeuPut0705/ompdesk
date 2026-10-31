import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { gitSync, initRepo } from "../local/git/test-repos";
import {
	BotTeach,
	type BotTeachDeps,
	gitCommits,
	TEACH_INSTRUCTION,
	TEACH_LINE_CHARS,
	TEACH_MAX_COMMITS,
	TEACH_MAX_LINES,
	TEACH_MAX_MS,
	TEACH_MAX_PROMPTS,
	TEACH_PROMPT_CHARS,
	type TeachMail,
	type TeachTab,
	typedLines,
} from "./bot-teach";

const BOT_FILE = "/s/bot.jsonl";
const START = Date.parse("2026-11-01T09:00:00Z");

const TABS: Record<string, TeachTab> = {
	bot: { title: "Bot", cwd: "/work", sessionPath: BOT_FILE, sessionId: "bot-id" },
	fix: { title: "Fix the build", cwd: "/repo/app", sessionPath: "/s/fix.jsonl", sessionId: "fix-id" },
	docs: { title: "Docs", cwd: "/repo/docs", sessionPath: "/s/docs.jsonl", sessionId: "docs-id" },
	fresh: { title: "", cwd: "/scratch" },
	away: {
		title: "On the mini",
		cwd: "/mini/repo",
		sessionPath: "/m/away.jsonl",
		device: "dev-1",
		deviceName: "Mac mini",
	},
};

function rig(options: { enabled?: boolean; commits?: Record<string, string[]>; deliverError?: Error } = {}) {
	let enabled = options.enabled ?? true;
	let now = START;
	let deliverError = options.deliverError ?? null;
	const delivered: TeachMail[] = [];
	const asked: { folder: string; since: string; limit: number }[] = [];
	let changes = 0;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextTimer = 1;
	const deps: BotTeachDeps = {
		enabled: () => enabled,
		botPath: () => (enabled ? BOT_FILE : null),
		tab: tabId => TABS[tabId] ?? null,
		commits: async (folder, since, limit) => {
			asked.push({ folder, since, limit });
			return options.commits?.[folder]?.slice(0, limit) ?? null;
		},
		deliver: async mail => {
			if (deliverError) {
				const error = deliverError;
				deliverError = null;
				throw error;
			}
			delivered.push(mail);
		},
		changed: () => void changes++,
		now: () => now,
		setTimer: (fn, ms) => {
			const handle = nextTimer++;
			timers.set(handle, { fn, ms });
			return handle;
		},
		clearTimer: handle => void timers.delete(handle as number),
	};
	const teach = new BotTeach(deps);
	return {
		teach,
		delivered,
		asked,
		changes: () => changes,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
		advance: (ms: number) => {
			now += ms;
		},
		/** The auto-stop timer fires. */
		fireTimer: async () => {
			for (const [handle, timer] of [...timers]) {
				timers.delete(handle);
				timer.fn();
			}
			await tick();
		},
		armed: () => [...timers.values()].map(timer => timer.ms),
	};
}

const keys = (text: string) => text.split("");

describe("typed terminal lines", () => {
	it("assembles lines from raw writes: Enter ends one, backspace and line editing change it, escapes and Ctrl-C vanish", () => {
		expect(typedLines("", "git status\r")).toEqual({ pending: "", lines: ["git status"] });
		expect(typedLines("", "git stauts\x7f\x7f\x7f\x7f\x7ftatus\r")).toEqual({ pending: "", lines: ["git status"] });
		expect(typedLines("", "ls\x1b[A\x1b[D -la\r")).toEqual({ pending: "", lines: ["ls -la"] });
		expect(typedLines("", "\x1b[I\x1b[12;40Rpwd\x1bOP\r\n")).toEqual({ pending: "", lines: ["pwd"] });
		expect(typedLines("", "rm -rf /\x03echo hi\r")).toEqual({ pending: "", lines: ["echo hi"] });
		expect(typedLines("", "wrong\x15right\r")).toEqual({ pending: "", lines: ["right"] });
		expect(typedLines("", "cd old new\x17dir\r")).toEqual({ pending: "", lines: ["cd old dir"] });
		expect(typedLines("", "one\rtwo\r\r  \r")).toEqual({ pending: "", lines: ["one", "two"] });
		expect(typedLines("", "echo 한글\r")).toEqual({ pending: "", lines: ["echo 한글"] });
	});

	it("keeps what is typed so far across writes and a pasted block with its own line breaks", () => {
		const first = typedLines("", "git com");
		expect(first).toEqual({ pending: "git com", lines: [] });
		expect(typedLines(first.pending, "mit -m x\r")).toEqual({ pending: "", lines: ["git commit -m x"] });
		expect(typedLines("", "\x1b[200~echo a\necho b\x1b[201~\r")).toEqual({
			pending: "",
			lines: ["echo a", "echo b"],
		});
	});
});

describe("showing the bot a workflow", () => {
	it("records the owner's prompts from the sessions they work in, never the bot's own, and mails them at Stop", async () => {
		const { teach, delivered, advance } = rig({
			commits: { "/repo/app": ["abc1234 fix the build", "def5678 add a test"] },
		});
		teach.prompt("fix", "before the recording");
		teach.start();
		expect(teach.state()).toEqual({ since: "2026-11-01T09:00:00.000Z" });
		advance(5_000);
		teach.prompt("fix", "Run the build and fix the failing test");
		advance(5_000);
		teach.prompt("bot", "the bot's own prompt");
		teach.prompt("gone", "a tab that closed");
		teach.prompt("away", "check the mini");
		teach.prompt("fresh", "a session not saved yet");
		advance(5_000);
		teach.prompt("fix", "Now commit it");
		teach.prompt("docs", "Update the changelog");

		await expect(teach.stop()).resolves.toEqual({ delivered: true });
		expect(teach.state()).toBeNull();
		expect(delivered).toHaveLength(1);
		const [{ id, text, instruction }] = delivered as [TeachMail];
		expect(id).toBe(`bot-teach-${START}`);
		expect(instruction).toBe(TEACH_INSTRUCTION);
		expect(instruction).toContain("manage_skill");
		expect(instruction).toContain("decide");
		expect(text).toContain("Window: 2026-11-01T09:00:00Z to 2026-11-01T09:00:15Z");
		expect(text).toContain('Session "Fix the build": folder /repo/app; session id fix-id, file /s/fix.jsonl');
		expect(text).toContain('Session "Docs": folder /repo/docs; session id docs-id, file /s/docs.jsonl');
		expect(text).toContain('Session "On the mini" on Mac mini: folder /mini/repo; file /m/away.jsonl');
		expect(text).toContain('Session "untitled": folder /scratch; not saved yet');
		expect(text).toContain("ompdesk_session_read");
		expect(text).toContain("2026-11-01T09:00:05Z prompt: Run the build and fix the failing test");
		expect(text).toContain("2026-11-01T09:00:15Z prompt: Now commit it");
		expect(text.indexOf("Run the build")).toBeLessThan(text.indexOf("Now commit it"));
		expect(text).not.toContain("before the recording");
		expect(text).not.toContain("the bot's own prompt");
		expect(text).not.toContain("a tab that closed");
		expect(text).toContain("    abc1234 fix the build");
		expect(text).toContain("    def5678 add a test");
	});

	it("keeps lines the owner typed in a terminal under their session and asks git about each folder once, on this computer only", async () => {
		const { teach, delivered, asked, advance } = rig({
			commits: { "/repo/app": ["abc1234 bump"], "/repo/docs": [] },
		});
		teach.start();
		advance(1_000);
		for (const part of keys("git pull\r")) teach.terminalWrite("fix", "t1", part);
		advance(1_000);
		teach.terminalWrite("fix", "t1", "bun test\x7f\x7f\x7f\x7fvitest\r");
		teach.terminalWrite("docs", "t1", "ls\r");
		teach.terminalWrite("fix", "t2", "echo half");
		teach.terminalWrite("bot", "t1", "the bot's terminal\r");
		teach.terminalWrite("away", "t1", "a paired computer's terminal\r");
		teach.prompt("fix", "and then?");

		await teach.stop();
		const text = delivered[0]?.text ?? "";
		expect(text).toContain("2026-11-01T09:00:01Z terminal: git pull");
		expect(text).toContain("2026-11-01T09:00:02Z terminal: bun vitest");
		expect(text).toContain("terminal: ls");
		expect(text).not.toContain("echo half");
		expect(text).not.toContain("the bot's terminal");
		expect(text).not.toContain("a paired computer's terminal");
		expect(text).toContain("Commits that landed meanwhile (git log --oneline --since=2026-11-01T09:00:00Z)");
		expect(asked.map(entry => entry.folder).sort()).toEqual(["/repo/app", "/repo/docs"]);
		expect(asked[0]?.since).toBe("2026-11-01T09:00:00Z");
		expect(text).toContain("  /repo/app\n    abc1234 bump");
		expect(text).not.toContain("/repo/docs\n");
	});

	it("says none when no folder gained a commit", async () => {
		const { teach, delivered } = rig();
		teach.start();
		teach.prompt("fix", "look around");
		await teach.stop();
		expect(delivered[0]?.text).toContain("\n  none");
	});

	it("delivers nothing for an empty recording and drops it", async () => {
		const { teach, delivered, changes } = rig();
		teach.start();
		teach.prompt("bot", "the bot's own prompt");
		teach.terminalWrite("fix", "t1", "half a line");
		await expect(teach.stop()).resolves.toEqual({ delivered: false });
		expect(delivered).toEqual([]);
		expect(teach.state()).toBeNull();
		expect(changes()).toBe(2);
		// Pressing Stop again (another window) is just as empty.
		await expect(teach.stop()).resolves.toEqual({ delivered: false });
		expect(delivered).toEqual([]);
	});

	it("drops the record on cancel", async () => {
		const { teach, delivered, armed, changes } = rig();
		teach.start();
		expect(armed()).toEqual([TEACH_MAX_MS]);
		teach.prompt("fix", "something");
		teach.cancel();
		expect(teach.state()).toBeNull();
		expect(armed()).toEqual([]);
		expect(changes()).toBe(2);
		await teach.stop();
		expect(delivered).toEqual([]);
		// A new recording starts clean.
		teach.start();
		teach.prompt("docs", "second try");
		await teach.stop();
		expect(delivered[0]?.text).not.toContain("something");
		expect(delivered[0]?.text).toContain("second try");
	});

	it("goes on with the recording it has when Record is pressed again", () => {
		const { teach, advance, changes } = rig();
		teach.start();
		advance(10_000);
		teach.start();
		expect(teach.state()).toEqual({ since: "2026-11-01T09:00:00.000Z" });
		expect(changes()).toBe(1);
	});

	it("is refused, and records nothing, while the bot is off", async () => {
		const { teach, delivered, setEnabled } = rig({ enabled: false });
		let refused: unknown;
		try {
			teach.start();
		} catch (error) {
			refused = error;
		}
		expect(ipcErrorCode(refused)).toBe("bot_off");
		setEnabled(true);
		teach.start();
		teach.prompt("fix", "while on");
		setEnabled(false);
		expect(teach.state()).toBeNull();
		teach.prompt("fix", "while off");
		await expect(teach.stop()).rejects.toThrow(/bot is off/);
		expect(delivered).toEqual([]);
		// The recording went with the switch.
		setEnabled(true);
		expect(teach.state()).toBeNull();
	});

	it("cuts prompts, terminal lines and commits at their bounds and says so in the record", async () => {
		const commits = Array.from({ length: TEACH_MAX_COMMITS + 20 }, (_, index) => `c${index} commit ${index}`);
		const { teach, delivered, asked } = rig({ commits: { "/repo/app": commits } });
		teach.start();
		for (let index = 0; index < TEACH_MAX_PROMPTS + 3; index++) teach.prompt("fix", `prompt ${index}`);
		for (let index = 0; index < TEACH_MAX_LINES + 2; index++) teach.terminalWrite("fix", "t1", `echo ${index}\r`);
		teach.prompt("docs", "one more than fits");
		await teach.stop();
		const text = delivered[0]?.text ?? "";
		expect(text).toContain(`prompts cut at ${TEACH_MAX_PROMPTS}: 4 later prompt(s) are not listed`);
		expect(text).toContain(`terminal lines cut at ${TEACH_MAX_LINES}: 2 later line(s) are not listed`);
		expect(text).toContain(`prompt ${TEACH_MAX_PROMPTS - 1}\n`);
		expect(text).not.toContain(`prompt ${TEACH_MAX_PROMPTS}\n`);
		expect(text).toContain(`echo ${TEACH_MAX_LINES - 1}\n`);
		expect(text).not.toContain(`echo ${TEACH_MAX_LINES}\n`);
		expect(text).toContain(`Commits cut at ${TEACH_MAX_COMMITS}`);
		expect(text).toContain(`c${TEACH_MAX_COMMITS - 1} commit`);
		expect(text).not.toContain(`c${TEACH_MAX_COMMITS} commit`);
		expect(asked[0]?.limit).toBe(TEACH_MAX_COMMITS + 1);
	});

	it("stops by itself after its time bound and hands the bot what it has", async () => {
		const { teach, delivered, advance, fireTimer, changes } = rig();
		teach.start();
		teach.prompt("fix", "an hour ago");
		advance(TEACH_MAX_MS);
		await fireTimer();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.text).toContain("an hour ago");
		expect(delivered[0]?.text).toContain("Window: 2026-11-01T09:00:00Z to 2026-11-01T10:00:00Z");
		expect(teach.state()).toBeNull();
		expect(changes()).toBe(2);
	});

	it("cuts a very long prompt and a very long typed line, and says so", async () => {
		const { teach, delivered } = rig();
		teach.start();
		teach.prompt("fix", "y".repeat(5_000));
		teach.terminalWrite("fix", "t1", `${"z".repeat(1_000)}\r`);
		await teach.stop();
		const text = delivered[0]?.text ?? "";
		expect(text).toContain(`${"y".repeat(TEACH_PROMPT_CHARS)}… (cut at ${TEACH_PROMPT_CHARS} characters)`);
		expect(text).toContain(`${"z".repeat(TEACH_LINE_CHARS)}… (cut at ${TEACH_LINE_CHARS} characters)`);
		expect(text).not.toContain("y".repeat(TEACH_PROMPT_CHARS + 1));
	});

	it("keeps recording when the bot cannot be reached, so Stop can be pressed again, and cuts what comes after the bound", async () => {
		const { teach, delivered, advance, fireTimer } = rig({
			deliverError: new Error("No window to open the session in."),
		});
		teach.start();
		teach.prompt("fix", "inside");
		advance(TEACH_MAX_MS);
		await fireTimer();
		expect(delivered).toEqual([]);
		expect(teach.state()).not.toBeNull();
		advance(60_000);
		teach.prompt("fix", "after the bound");
		await expect(teach.stop()).resolves.toEqual({ delivered: true });
		const text = delivered[0]?.text ?? "";
		expect(text).toContain("inside");
		expect(text).not.toContain("after the bound");
		expect(text).toContain("time cut at 2026-11-01T10:00:00Z (60 minutes)");
	});

	it("hands the bot one record when Stop is pressed twice at once", async () => {
		const { teach, delivered } = rig();
		teach.start();
		teach.prompt("fix", "once");
		const [a, b] = await Promise.all([teach.stop(), teach.stop()]);
		expect(a).toEqual({ delivered: true });
		expect(b).toEqual({ delivered: true });
		expect(delivered).toHaveLength(1);
	});
});

describe("gitCommits", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("lists the commits since a time, newest first and cut at the limit, and none for a folder that is no repository", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-teach-"));
		const repo = path.join(dir, "repo");
		await initRepo(repo);
		const before = "2000-01-01T00:00:00Z";
		await fs.writeFile(path.join(repo, "a.txt"), "a\n");
		gitSync(repo, "add", ".");
		gitSync(repo, "commit", "-q", "-m", "add a");
		await fs.writeFile(path.join(repo, "b.txt"), "b\n");
		gitSync(repo, "add", ".");
		gitSync(repo, "commit", "-q", "-m", "add b");

		const since = await gitCommits(repo, before, 10);
		expect(since?.map(line => line.slice(line.indexOf(" ") + 1))).toEqual(["add b", "add a", "init"]);
		expect(await gitCommits(repo, before, 1)).toHaveLength(1);
		const future = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
		expect(await gitCommits(repo, future, 10)).toEqual([]);
		expect(await gitCommits(dir, before, 10)).toBeNull();
	});
});
