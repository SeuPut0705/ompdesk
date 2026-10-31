import { describe, expect, it } from "vitest";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { type BotTakeoverDeps, BotTakeovers, TAKEOVER_INSTRUCTION, takeoverAction } from "./bot-takeover";
import { CAPTURE_HIDDEN_AT_PROMPT } from "./terminal-capture";

const CHILD = "/s/child.jsonl";
const START = Date.parse("2026-11-01T09:00:00Z");

function rig(overrides: Partial<BotTakeoverDeps> = {}) {
	let now = START;
	const stopped: string[] = [];
	const notes: { sessionPath: string; id: string; text: string; instruction: string }[] = [];
	const activity: Parameters<BotTakeoverDeps["activity"]>[0][] = [];
	let changes = 0;
	let on = true;
	const takeovers = new BotTakeovers({
		enabled: () => on,
		session: sessionPath => (sessionPath === CHILD ? { title: "Fix the build", cwd: "/work/repo-wt" } : null),
		stop: sessionPath => void stopped.push(sessionPath),
		deliver: async (sessionPath, note) => void notes.push({ sessionPath, ...note }),
		activity: entry => void activity.push(entry),
		changed: () => void changes++,
		now: () => now,
		...overrides,
	});
	return {
		takeovers,
		stopped,
		notes,
		activity,
		changes: () => changes,
		advance: (ms: number) => {
			now += ms;
		},
		turnOff: () => {
			on = false;
		},
	};
}

/** The owner types `line` and the terminal echoes it, then prints `printed` and a new prompt. */
function run(takeovers: BotTakeovers, terminal: string, offset: { at: number }, line: string, printed = "") {
	takeovers.terminalWrite(CHILD, terminal, `${line}\r`);
	const output = `${line}\r\n${printed}$ `;
	offset.at += output.length;
	takeovers.terminalOutput(CHILD, terminal, offset.at, output);
}

describe("taking over a session the bot opened", () => {
	it("stops its turn, lists it on the desk and captures only what is typed after the take", () => {
		const { takeovers, stopped, activity, changes } = rig();
		takeovers.terminalWrite(CHILD, "t|1", "echo before\r");
		takeovers.take(CHILD);
		expect(stopped).toEqual([CHILD]);
		expect(takeovers.state()).toEqual([{ sessionPath: CHILD, since: new Date(START).toISOString() }]);
		expect(activity).toEqual([{ action: "take_over", text: "Fix the build", sessionPath: CHILD }]);
		expect(changes()).toBe(1);
		// A second take (another window, a double press) stops again but records nothing new.
		takeovers.take(CHILD);
		expect(activity).toHaveLength(1);
	});

	it("is refused while the bot is off and for a session no tab holds", () => {
		const off = rig();
		off.turnOff();
		expect(() => off.takeovers.take(CHILD)).toThrow();
		const { takeovers } = rig();
		let code: unknown;
		try {
			takeovers.take("/s/elsewhere.jsonl");
		} catch (error) {
			code = ipcErrorCode(error);
		}
		expect(code).toBe("session_not_open");
		expect(takeovers.state()).toEqual([]);
	});

	it("hands back with the commands the owner ran, never a password or a token, and starts its turn", async () => {
		const { takeovers, notes, activity, advance } = rig();
		takeovers.take(CHILD);
		const offset = { at: 0 };
		advance(60_000);
		run(takeovers, "t|1", offset, "git status", "nothing to commit\r\n");
		// A no-echo password prompt: the command and the prompt show, what is typed at it does not.
		const print = (text: string) => {
			offset.at += text.length;
			takeovers.terminalOutput(CHILD, "t|1", offset.at, text);
		};
		takeovers.terminalWrite(CHILD, "t|1", "read -s -p 'Password: ' pw\r");
		print("read -s -p 'Password: ' pw\r\nPassword: ");
		takeovers.terminalWrite(CHILD, "t|1", "hunter2-takeover\r");
		print("\r\n$ ");
		run(
			takeovers,
			"t|1",
			offset,
			"curl -H 'Authorization: Bearer sk-live-abcdef1234567890abcdef' https://api.example.com",
		);
		advance(60_000);

		await expect(takeovers.handBack(CHILD)).resolves.toEqual({ lines: 4 });
		expect(notes).toHaveLength(1);
		const note = notes[0];
		expect(note?.sessionPath).toBe(CHILD);
		expect(note?.instruction).toBe(TAKEOVER_INSTRUCTION);
		expect(note?.text).toContain(
			"took this session over at 2026-11-01T09:00:00Z and handed it back at 2026-11-01T09:02:00Z",
		);
		expect(note?.text).toContain("(folder /work/repo-wt)");
		expect(note?.text).toContain("$ git status");
		expect(note?.text).toContain("$ read -s -p 'Password: ' pw");
		expect(note?.text).toContain(`$ ${CAPTURE_HIDDEN_AT_PROMPT}`);
		expect(note?.text).toContain("$ curl -H 'Authorization:");
		expect(note?.text).not.toContain("hunter2");
		expect(note?.text).not.toContain("sk-live-abcdef1234567890abcdef");
		// The log names the session and how much was handed back, never a line.
		expect(activity.at(-1)).toEqual({
			action: "hand_back",
			text: "Fix the build",
			sessionPath: CHILD,
			detail: "4 terminal lines",
		});
		expect(JSON.stringify(activity)).not.toContain("hunter2");
		expect(JSON.stringify(activity)).not.toContain("curl");
		expect(takeovers.state()).toEqual([]);
		// Typing after the hand-back is the session's own business again.
		takeovers.terminalWrite(CHILD, "t|1", "echo after\r");
		await expect(takeovers.handBack(CHILD)).resolves.toEqual({});
	});

	it("says the owner ran nothing when they typed nothing", async () => {
		const { takeovers, notes } = rig();
		takeovers.take(CHILD);
		await expect(takeovers.handBack(CHILD)).resolves.toEqual({ lines: 0 });
		expect(notes[0]?.text).toContain("They ran nothing in this session's terminal.");
	});

	it("keeps the takeover when the session cannot be told, so Hand back can be pressed again", async () => {
		let fail = true;
		const told: string[] = [];
		const { takeovers } = rig({
			deliver: async (_sessionPath, note) => {
				if (fail) throw new Error("No window to open the session in.");
				told.push(note.text);
			},
		});
		takeovers.take(CHILD);
		await expect(takeoverAction(takeovers, { action: "handBack", sessionPath: CHILD })).rejects.toThrow(/No window/);
		expect(takeovers.state()).toHaveLength(1);
		fail = false;
		await expect(takeoverAction(takeovers, { action: "handBack", sessionPath: CHILD })).resolves.toEqual({
			lines: 0,
		});
		expect(told).toHaveLength(1);
	});

	it("tells the session once when Hand back is pressed twice at once", async () => {
		const { takeovers, notes } = rig();
		takeovers.take(CHILD);
		await Promise.all([takeovers.handBack(CHILD), takeovers.handBack(CHILD)]);
		expect(notes).toHaveLength(1);
	});

	it("ends every takeover without a note when the bot is turned off", () => {
		const { takeovers, notes, turnOff } = rig();
		takeovers.take(CHILD);
		turnOff();
		expect(takeovers.state()).toEqual([]);
		takeovers.clear();
		expect(notes).toEqual([]);
	});
});
