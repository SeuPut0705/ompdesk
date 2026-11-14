/**
 * The quit area (`src/main/app-quit.ts`, `quit-watchdog.ts`, the rules of `quit-guard.ts`): the pure rules over their
 * inputs, the confirmation dialogs `confirmQuit` and `confirmUpdateRestart` open (the `dialog.messageBox` frames over the
 * fake shell, in both languages), and the watchdog's arm / disarm / fire sequences on a fake clock.
 */
import Store from "electron-store";
import { backgroundWorkSentence, hasBackgroundWork } from "../../../src/main/background-work";
import { MAIN_TEXT } from "../../../src/main/i18n-text";
import {
	activateAction,
	assessQuitRisk,
	quitNeedsConfirmation,
	updateRestartConfirmation,
	type WindowTabFact,
} from "../../../src/main/quit-guard";
import { QUIT_EXIT_TIMEOUT_MS, QuitWatchdog, type QuitWatchdogReport } from "../../../src/main/quit-watchdog";
import type { Step } from "../capture-chrome";
import { type Frame, fakeShell } from "./fake-shell";

const RISKS = {
	idle: [fact(1, "a", false), fact(1, "b", false)],
	none: [],
	one: [fact(1, "a", true), fact(1, "b", false)],
	sameWindow: [fact(7, "a", true), fact(7, "b", true), fact(7, "c", true)],
	manyWindows: [fact(1, "a", true), fact(1, "b", false), fact(2, "c", true), fact(3, "d", false)],
	two: [fact(1, "a", true), fact(2, "b", true)],
} satisfies Record<string, WindowTabFact[]>;

const WORKS = {
	none: { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [] },
	subagents: { subagents: 2, jobs: 0, subagentLabels: ["LayoutSplit", "StreamFast"], jobLabels: [] },
	jobs: { subagents: 0, jobs: 1, subagentLabels: [], jobLabels: ["dev server"] },
	mixed: { subagents: 2, jobs: 1, subagentLabels: ["LayoutSplit", "StreamFast"], jobLabels: ["dev server"] },
	unknown: { subagents: 0, jobs: 0, subagentLabels: [], jobLabels: [], unknown: 2 },
	many: {
		subagents: 5,
		jobs: 2,
		subagentLabels: ["a", "b", "c", "d", "e"],
		jobLabels: ["a long label that goes past the forty character cut of one line", "x"],
	},
};

function fact(windowId: number, tabId: string, inFlight: boolean): WindowTabFact {
	return { windowId, tabId, inFlight };
}

function rules(): Step[] {
	const steps: Step[] = [];
	for (const [name, facts] of Object.entries(RISKS)) {
		const risk = assessQuitRisk(facts);
		for (const resumes of [false, true]) {
			steps.push({
				fn: "src/main/quit-guard.ts#quitNeedsConfirmation",
				input: { risk, resumes, name },
				output: quitNeedsConfirmation(risk, resumes),
			});
			for (const [workName, work] of Object.entries(WORKS)) {
				steps.push({
					fn: "src/main/quit-guard.ts#updateRestartConfirmation",
					input: { risk, resumes, has: hasBackgroundWork(work), name: `${name}/${workName}` },
					output: updateRestartConfirmation(risk, resumes, work),
				});
			}
		}
	}
	for (const quitApproved of [false, true]) {
		for (const windowCount of [0, 1, 3]) {
			for (const anyVisible of [false, true]) {
				steps.push({
					fn: "src/main/quit-guard.ts#activateAction",
					input: { quitApproved, windowCount, anyVisible },
					output: activateAction({ quitApproved, windowCount, anyVisible }),
				});
			}
		}
	}
	return steps;
}

/** The text the dialogs read: every key of the two quit confirmations in both languages. */
function labels(): Step[] {
	const text: Record<"en" | "ko", Record<string, string>> = { en: {}, ko: {} };
	for (const key of Object.keys(MAIN_TEXT)) {
		if (!key.startsWith("quit.") && !key.startsWith("updates.restartWork.")) continue;
		text.en[key] = MAIN_TEXT[key as keyof typeof MAIN_TEXT].en;
		text.ko[key] = MAIN_TEXT[key as keyof typeof MAIN_TEXT].ko;
	}
	return [{ fn: "src/main/i18n-text.ts#MAIN_TEXT", input: {}, output: text }];
}

/** The `options` of a `dialog.messageBox` frame. */
function optionsOf(frame: Frame): unknown {
	const params = frame.params;
	return params && typeof params === "object" && "options" in params ? params.options : undefined;
}

async function dialogs(): Promise<Step[]> {
	const steps: Step[] = [];
	const shell = await fakeShell();
	const prefs = new Store<{ language?: string }>({ name: "prefs" });
	// Static imports cannot work: these modules read `electron` (and open the prefs store) while they load, which needs
	// the fake shell above to be current first.
	const quit = await import("../../../src/main/app-quit");
	const { mainT } = await import("../../../src/main/i18n");
	let inventory: WindowTabFact[] = [];
	quit.installQuitGuard(
		() => inventory,
		() => {},
		async () => {},
		async () => {},
	);
	let response = 0;
	shell.answer("dialog.messageBox", () => ({ response }));
	for (const language of ["en", "ko"] as const) {
		prefs.set("language", language);
		for (const [name, facts] of Object.entries(RISKS)) {
			for (const resumes of [false, true]) {
				for (const answer of [0, 1]) {
					inventory = facts;
					response = answer;
					quit.setQuitResumes(() => resumes);
					shell.take();
					const result = await quit.confirmQuit();
					const frames = shell.take().filter(frame => frame.method === "dialog.messageBox");
					steps.push({
						fn: "src/main/app-quit.ts#confirmQuit",
						input: { language, facts: name, risk: assessQuitRisk(facts), resumes, response: answer },
						output: { result, dialogs: frames.map(optionsOf) },
					});
				}
			}
		}
		for (const [name, facts] of Object.entries(RISKS)) {
			for (const resumes of [false, true]) {
				for (const [workName, work] of Object.entries(WORKS)) {
					for (const answer of [0, 1]) {
						inventory = facts;
						response = answer;
						quit.setQuitResumes(() => resumes);
						let read = 0;
						shell.take();
						const result = await quit.confirmUpdateRestart(async () => {
							read += 1;
							return work;
						});
						const frames = shell.take().filter(frame => frame.method === "dialog.messageBox");
						steps.push({
							fn: "src/main/app-quit.ts#confirmUpdateRestart",
							input: {
								language,
								facts: name,
								risk: assessQuitRisk(facts),
								resumes,
								work: workName,
								has: hasBackgroundWork(work),
								sentence: backgroundWorkSentence(work, (key, params) => mainT(key, language, params)),
								response: answer,
							},
							output: {
								result,
								workRead: read,
								dialogs: frames.map(optionsOf),
							},
						});
					}
				}
			}
		}
	}
	shell.close();
	return steps;
}

type Op =
	| { op: "arm"; reason: "quit" | "update" }
	| { op: "disarm"; reason?: "quit" | "update" }
	| { op: "advance"; ms: number };

const SEQUENCES: Array<{ name: string; timeoutMs?: number; ops: Op[] }> = [
	{
		name: "fires at the deadline, not before",
		ops: [
			{ op: "arm", reason: "update" },
			{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS - 1 },
			{ op: "advance", ms: 1 },
		],
	},
	{ name: "nothing armed", ops: [{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS * 2 }] },
	{
		name: "cancelled",
		ops: [
			{ op: "arm", reason: "update" },
			{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS / 2 },
			{ op: "disarm" },
			{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS * 2 },
		],
	},
	{
		name: "disarm by reason",
		ops: [
			{ op: "arm", reason: "quit" },
			{ op: "disarm", reason: "update" },
			{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS },
			{ op: "arm", reason: "update" },
			{ op: "disarm", reason: "update" },
			{ op: "advance", ms: QUIT_EXIT_TIMEOUT_MS },
		],
	},
	{
		name: "a second arm keeps the first deadline",
		timeoutMs: 1000,
		ops: [
			{ op: "arm", reason: "quit" },
			{ op: "advance", ms: 600 },
			{ op: "arm", reason: "update" },
			{ op: "advance", ms: 400 },
			{ op: "advance", ms: 5000 },
		],
	},
	{
		name: "armed again after a cancel",
		timeoutMs: 1000,
		ops: [
			{ op: "arm", reason: "update" },
			{ op: "disarm" },
			{ op: "arm", reason: "update" },
			{ op: "advance", ms: 1000 },
		],
	},
	{
		name: "armed again after firing",
		timeoutMs: 1000,
		ops: [
			{ op: "arm", reason: "quit" },
			{ op: "advance", ms: 1000 },
			{ op: "arm", reason: "update" },
			{ op: "advance", ms: 999 },
			{ op: "advance", ms: 1 },
		],
	},
	{
		name: "disarm of a fired watchdog",
		timeoutMs: 1000,
		ops: [{ op: "arm", reason: "quit" }, { op: "advance", ms: 1000 }, { op: "disarm" }],
	},
];

function watchdog(): Step[] {
	const steps: Step[] = [];
	for (const sequence of SEQUENCES) {
		let now = 0;
		const timers = new Map<number, { at: number; fn: () => void }>();
		let nextTimer = 1;
		const logs: QuitWatchdogReport[] = [];
		let exits = 0;
		const dog = new QuitWatchdog({
			setTimer: (fn, ms) => {
				const id = nextTimer++;
				timers.set(id, { at: now + ms, fn });
				return id;
			},
			clearTimer: handle => void timers.delete(handle as number),
			log: report => logs.push(report),
			exit: () => {
				exits += 1;
			},
			timeoutMs: sequence.timeoutMs,
		});
		const outputs: unknown[] = [];
		for (const op of sequence.ops) {
			if (op.op === "arm") dog.arm(op.reason);
			else if (op.op === "disarm") dog.disarm(op.reason);
			else {
				now += op.ms;
				for (const [id, timer] of [...timers]) {
					if (timer.at > now) continue;
					timers.delete(id);
					timer.fn();
				}
			}
			outputs.push({ armed: dog.armed, logs: logs.splice(0), exits });
		}
		steps.push({
			fn: "src/main/quit-watchdog.ts#QuitWatchdog",
			input: { name: sequence.name, timeoutMs: sequence.timeoutMs ?? QUIT_EXIT_TIMEOUT_MS, ops: sequence.ops },
			output: outputs,
		});
	}
	return steps;
}

export async function capture(): Promise<Step[]> {
	return [...rules(), ...labels(), ...(await dialogs()), ...watchdog()];
}
