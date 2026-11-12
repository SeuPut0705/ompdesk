import { describe, expect, it } from "vitest";
import {
	AUTO_INSTALL_CARD_HOLD_MS,
	AUTO_INSTALL_COUNTDOWN_MS,
	AUTO_INSTALL_IDLE_MS,
	AUTO_INSTALL_MAX_WAIT_MS,
	type AutoInstallFacts,
	AutoInstallScheduler,
	quietMoment,
} from "./app-auto-update";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** The owner's ten minutes (12 Nov 2026): how long a card holds the restart with nobody giving the computer input. */
const CARD_HOLD = 10 * MINUTE;
const ANNOUNCE = `announce:${AUTO_INSTALL_COUNTDOWN_MS}`;

/** The scheduler on a clock the test moves; `calls` records every effect in order. */
function setup(initial: Partial<AutoInstallFacts> = {}) {
	let time = 1_000_000;
	const facts: AutoInstallFacts = {
		enabled: true,
		installable: true,
		resumes: true,
		busy: false,
		focused: true,
		idleMs: 0,
		...initial,
	};
	const calls: string[] = [];
	/** Each logged transition: `event` plus its details as `key=value`, in order. */
	const logs: string[] = [];
	const scheduler = new AutoInstallScheduler({
		log: (event, details = {}) =>
			logs.push([event, ...Object.entries(details).map(([key, value]) => `${key}=${value}`)].join(" ")),
		now: () => time,
		facts: () => facts,
		effects: {
			announce: restartAt => calls.push(`announce:${restartAt - time}`),
			withdraw: () => calls.push("withdraw"),
			install: () => calls.push("install"),
		},
	});
	return {
		facts,
		calls,
		logs,
		scheduler,
		now: () => time,
		advance(ms: number) {
			time += ms;
			scheduler.tick();
		},
	};
}

describe("quietMoment", () => {
	it("needs no running turn, then either an unfocused app or two idle minutes", () => {
		const base: AutoInstallFacts = {
			enabled: true,
			installable: true,
			resumes: true,
			busy: false,
			focused: true,
			idleMs: 0,
		};
		expect(quietMoment(base)).toBe(false);
		expect(quietMoment({ ...base, focused: false })).toBe(true);
		expect(quietMoment({ ...base, idleMs: AUTO_INSTALL_IDLE_MS - 1 })).toBe(false);
		expect(quietMoment({ ...base, idleMs: AUTO_INSTALL_IDLE_MS })).toBe(true);
		expect(quietMoment({ ...base, busy: true, focused: false, idleMs: 10 * MINUTE })).toBe(false);
	});
});

describe("AutoInstallScheduler", () => {
	it("does nothing with the pref off, however idle", () => {
		const t = setup({ enabled: false, focused: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS * 2);
		expect(t.calls).toEqual([]);
	});

	it("does nothing until an update is installable", () => {
		const t = setup({ installable: false, focused: false });
		t.advance(MINUTE);
		expect(t.calls).toEqual([]);
	});

	it("announces at an idle moment, then installs when the countdown ends", () => {
		const t = setup({ focused: false });
		t.advance(0);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS - 1);
		expect(t.calls).toHaveLength(1);
		t.advance(1);
		// The countdown's end asks for a last look that also stops new work; the tick its answer brings installs.
		t.advance(0);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "install"]);
	});

	it("is done once it installs: the restart's stall is not met with a second notice and a second install", () => {
		const t = setup({ focused: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		// Windows' installer start blocked the app for 5.6 s; the update still reads as installable when it ticks again.
		t.advance(5600);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "install"]);
		expect(t.logs.map(line => line.split(" ")[0])).toEqual(["safe", "countdown", "install"]);
	});

	it("starts over when the install failed and the update is ready again", () => {
		const t = setup({ focused: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(0);
		t.facts.installable = false;
		t.advance(1000);
		t.facts.installable = true;
		t.advance(1000);
		expect(t.calls).toEqual([
			`announce:${AUTO_INSTALL_COUNTDOWN_MS}`,
			"install",
			`announce:${AUTO_INSTALL_COUNTDOWN_MS}`,
		]);
	});

	it("treats no input for two minutes as idle even while focused, when resume is off", () => {
		const t = setup({ focused: true, idleMs: AUTO_INSTALL_IDLE_MS - 1, resumes: false });
		t.advance(0);
		expect(t.calls).toEqual([]);
		t.facts.idleMs = AUTO_INSTALL_IDLE_MS;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
	});

	it("waits while a tab works, even unfocused, when resume is off", () => {
		const t = setup({ focused: false, busy: true, resumes: false });
		t.advance(0);
		t.advance(10 * MINUTE);
		expect(t.calls).toEqual([]);
		t.facts.busy = false;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
	});

	it("with resume on, starts the countdown at once although a turn runs and the user types: it resumes after", () => {
		const t = setup({ busy: true, focused: true, idleMs: 0, resumes: true });
		t.advance(0);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(0);
		expect(t.calls.at(-1)).toBe("install");
	});

	it("with resume on, waits for an open ask or a compaction while someone gives input, before the countdown and at its end", () => {
		const t = setup({ busy: true, asking: true, focused: false, resumes: true });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS * 2);
		expect(t.calls).toEqual([]);
		t.facts.asking = false;
		t.facts.compacting = true;
		t.advance(1000);
		expect(t.calls).toEqual([]);
		t.facts.compacting = false;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
		// The card or the compaction comes up during the countdown: the restart holds until it is gone.
		t.facts.compacting = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(10 * MINUTE);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
		t.facts.compacting = false;
		t.facts.asking = true;
		t.advance(1000);
		expect(t.calls).toHaveLength(1);
		t.facts.asking = false;
		t.advance(1000);
		t.advance(0);
		expect(t.calls.at(-1)).toBe("install");
	});

	it("with resume on, goes back to a quiet moment or the max wait after the user's Later", () => {
		const t = setup({ busy: true, focused: true, resumes: true });
		t.advance(0);
		t.scheduler.postpone();
		t.advance(AUTO_INSTALL_MAX_WAIT_MS - 1);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "withdraw"]);
		t.advance(1);
		expect(t.calls.at(-1)).toBe(`announce:${AUTO_INSTALL_COUNTDOWN_MS}`);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(0);
		expect(t.calls.at(-1)).toBe("install");
	});

	it("never forces a restart over running work when resume is off", () => {
		const t = setup({ busy: true, focused: true, resumes: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS * 3);
		expect(t.calls).toEqual([]);
		t.facts.busy = false;
		t.facts.focused = false;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
	});

	it("drops a countdown that work started during, when resume is off, and waits for idle again", () => {
		const t = setup({ focused: false, resumes: false });
		t.advance(0);
		t.facts.busy = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "withdraw"]);
		t.facts.busy = false;
		t.advance(1000);
		expect(t.calls.at(-1)).toBe(`announce:${AUTO_INSTALL_COUNTDOWN_MS}`);
	});

	it("installs through a countdown that work started during when resume is on", () => {
		const t = setup({ focused: false, resumes: true });
		t.advance(0);
		t.facts.busy = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(0);
		expect(t.calls.at(-1)).toBe("install");
	});

	it("postpones to the next idle window and restarts the max wait", () => {
		const t = setup({ focused: false });
		t.advance(0);
		t.scheduler.postpone();
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "withdraw"]);
		// The user is back at the keyboard: nothing until they are idle again.
		t.facts.focused = true;
		t.facts.idleMs = 0;
		t.advance(AUTO_INSTALL_MAX_WAIT_MS - 1);
		expect(t.calls).toHaveLength(2);
		// The max wait counts from the postponement, not from the download.
		t.advance(1);
		expect(t.calls.at(-1)).toBe(`announce:${AUTO_INSTALL_COUNTDOWN_MS}`);
	});

	it("postponing with no countdown does nothing", () => {
		const t = setup({ focused: true });
		t.scheduler.postpone();
		expect(t.calls).toEqual([]);
	});

	it("withdraws the notice when the pref is turned off during the countdown", () => {
		const t = setup({ focused: false });
		t.advance(0);
		t.facts.enabled = false;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`, "withdraw"]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toHaveLength(2);
	});
});

// 12 Nov 2026: the update was verified at 06:12:58, a question card was open and the owner asleep; the scheduler waited
// on the card for 110 minutes, until he clicked the restart himself at 08:02:34.
describe("AutoInstallScheduler and a card nobody answers", () => {
	it("gives way to an ask or approval card after ten minutes with no input: the countdown, then the install", () => {
		expect(AUTO_INSTALL_CARD_HOLD_MS).toBe(CARD_HOLD);
		const t = setup({ busy: true, asking: true, focused: false, idleMs: 3 * HOUR, resumes: true });
		t.advance(0);
		t.advance(CARD_HOLD - 1000);
		expect(t.calls).toEqual([]);
		t.advance(1000);
		expect(t.calls).toEqual([ANNOUNCE]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toEqual([ANNOUNCE, "install"]);
		expect(t.logs).toEqual([
			"waiting reason=open ask waitedMs=0",
			`unattended heldMs=${CARD_HOLD} idleMs=${3 * HOUR}`,
			expect.stringMatching(/^countdown restartAt=\d+$/),
			"install trigger=auto",
		]);
	});

	it("keeps waiting while someone gives input, and gives way ten minutes after the last input", () => {
		const t = setup({ busy: true, asking: true, focused: true, idleMs: 0, resumes: true });
		t.advance(0);
		t.advance(3 * HOUR);
		t.facts.idleMs = CARD_HOLD - 1000;
		t.advance(1000);
		expect(t.calls).toEqual([]);
		t.facts.idleMs = CARD_HOLD;
		t.advance(1000);
		expect(t.calls).toEqual([ANNOUNCE]);
	});

	it("holds again when input comes during the countdown, and starts over: ten more minutes, a fresh countdown", () => {
		const t = setup({ busy: true, asking: true, focused: false, idleMs: CARD_HOLD, resumes: true });
		t.advance(0);
		t.advance(CARD_HOLD);
		expect(t.calls).toEqual([ANNOUNCE]);
		t.facts.idleMs = 5000;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(CARD_HOLD);
		expect(t.calls).toEqual([ANNOUNCE]);
		t.facts.idleMs = CARD_HOLD;
		t.advance(1000);
		expect(t.calls).toEqual([ANNOUNCE, ANNOUNCE]);
		t.facts.idleMs = CARD_HOLD + AUTO_INSTALL_COUNTDOWN_MS;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toEqual([ANNOUNCE, ANNOUNCE, "install"]);
		expect(t.logs.map(line => line.split(" ")[0])).toEqual([
			"waiting",
			"unattended",
			"countdown",
			"held",
			"unattended",
			"countdown",
			"install",
		]);
	});

	it("holds at the countdown's end for a card that came up during it, and gives way through a fresh countdown", () => {
		const t = setup({ focused: false, idleMs: 3 * HOUR, resumes: true });
		t.advance(0);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS - 1000);
		t.facts.busy = true;
		t.facts.asking = true;
		t.advance(1000);
		t.advance(CARD_HOLD - 1000);
		expect(t.calls).toEqual([ANNOUNCE]);
		t.advance(1000);
		expect(t.calls).toEqual([ANNOUNCE, ANNOUNCE]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.calls).toEqual([ANNOUNCE, ANNOUNCE, "install"]);
	});

	it("never gives way to a compaction, however long nobody is there, even with a card open beside it", () => {
		const t = setup({ busy: true, compacting: true, focused: false, idleMs: 24 * HOUR, resumes: true });
		t.advance(0);
		t.advance(24 * HOUR);
		t.facts.asking = true;
		t.advance(24 * HOUR);
		expect(t.calls).toEqual([]);
		t.facts.compacting = false;
		t.facts.asking = false;
		t.advance(1000);
		t.facts.compacting = true;
		t.facts.asking = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(24 * HOUR);
		expect(t.calls).toEqual([ANNOUNCE]);
	});

	it("never gives way to a plan proposal, which a relaunch would lose, before the countdown or at its end", () => {
		const t = setup({ asking: true, planWaiting: true, focused: false, idleMs: 24 * HOUR, resumes: true });
		t.advance(0);
		t.advance(24 * HOUR);
		expect(t.calls).toEqual([]);
		t.facts.asking = false;
		t.facts.planWaiting = false;
		t.advance(1000);
		t.facts.asking = true;
		t.facts.planWaiting = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(24 * HOUR);
		expect(t.calls).toEqual([ANNOUNCE]);
	});

	it("never gives way with resume off: the restart would lose the turn", () => {
		const t = setup({ busy: true, asking: true, focused: false, idleMs: 24 * HOUR, resumes: false });
		t.advance(0);
		t.advance(24 * HOUR);
		expect(t.calls).toEqual([]);
		expect(t.logs).toEqual(["waiting reason=open ask waitedMs=0"]);
	});

	it("decides nothing more once an install began elsewhere: a click, a paired device's, a quit", () => {
		const t = setup({ busy: true, asking: true, focused: false, resumes: true });
		t.advance(0);
		t.scheduler.installStarted("user click");
		t.facts.busy = false;
		t.facts.asking = false;
		t.advance(1000);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS);
		t.scheduler.postpone();
		expect(t.calls).toEqual([]);
		expect(t.logs).toEqual(["waiting reason=open ask waitedMs=0", "install trigger=user click"]);
		// "Now" on the countdown: the deadline starts nothing more.
		const c = setup({ focused: false });
		c.advance(0);
		c.scheduler.installStarted("user click");
		c.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(c.scheduler.restartAt).toBeUndefined();
		expect(c.calls).toEqual([ANNOUNCE]);
		expect(c.logs.map(line => line.split(" ")[0])).toEqual(["safe", "countdown", "install"]);
	});

	// The scheduler sees the cards once a second (its tick): one closed and another opened between two ticks is one card.
	it("installs over a card only after it held ten minutes with no input for as long, never over a compaction or a plan proposal: every sequence of seven steps", () => {
		const STEPS = ["1s", "1min", "10min", "ask", "plan", "compact", "input", "away"] as const;
		const LENGTH = 7;
		const violations: string[] = [];
		let overCard = 0;
		for (let n = 0; n < STEPS.length ** LENGTH; n++) {
			const t = setup({ focused: false, idleMs: 0, resumes: true });
			let ask = false;
			let plan = false;
			let openAtLastTick = false;
			let openedAt = 0;
			const done: string[] = [];
			t.advance(0);
			for (let i = 0, code = n; i < LENGTH; i++, code = Math.floor(code / STEPS.length)) {
				const step = STEPS[code % STEPS.length];
				done.push(step ?? "");
				if (step === "ask") ask = !ask;
				else if (step === "plan") plan = !plan;
				else if (step === "compact") t.facts.compacting = !t.facts.compacting;
				else if (step === "input") t.facts.idleMs = 0;
				else if (step === "away") t.facts.idleMs = 24 * HOUR;
				t.facts.asking = ask || plan;
				t.facts.busy = ask || plan;
				t.facts.planWaiting = plan;
				const before = t.calls.length;
				if (step === "1s") t.advance(1000);
				else if (step === "1min") t.advance(MINUTE);
				else if (step === "10min") t.advance(CARD_HOLD);
				else continue;
				if (t.facts.asking && !openAtLastTick) openedAt = t.now();
				openAtLastTick = t.facts.asking;
				if (t.calls.length === before || t.calls.at(-1) !== "install") continue;
				if (t.facts.compacting) violations.push(`over a compaction: ${done}`);
				if (plan) violations.push(`over a plan proposal: ${done}`);
				if (ask && (t.now() - openedAt < CARD_HOLD || t.facts.idleMs < CARD_HOLD))
					violations.push(`over an attended card: ${done}`);
				if (ask) overCard++;
			}
			if (t.calls.filter(call => call === "install").length > 1) violations.push(`installed twice: ${done}`);
		}
		expect(violations).toEqual([]);
		expect(overCard).toBeGreaterThan(0);
	});
});

describe("AutoInstallScheduler decision log", () => {
	it("writes each transition once, from busy through quiet and countdown to the install", () => {
		const t = setup({ focused: false, busy: true, resumes: false });
		t.advance(0);
		// Ten minutes of the same busy turn, one tick a second: still the one line.
		for (let second = 0; second < 600; second++) t.advance(1000);
		expect(t.logs).toEqual(["waiting reason=busy turn waitedMs=0"]);
		t.facts.busy = false;
		t.advance(1000);
		expect(t.logs).toEqual([
			"waiting reason=busy turn waitedMs=0",
			`quiet waitedMs=${601 * 1000} idleMs=0 focused=false`,
			expect.stringMatching(/^countdown restartAt=\d+$/),
		]);
		for (let second = 0; second < 59; second++) t.advance(1000);
		expect(t.logs).toHaveLength(3);
		t.advance(1000);
		expect(t.logs.slice(3)).toEqual(["install trigger=auto"]);
		expect(t.calls.at(-1)).toBe("install");
	});

	it("logs a changed wait reason, and the quiet moment, but never the same reason twice", () => {
		const t = setup({ focused: true, busy: false, idleMs: 0, resumes: false });
		t.advance(0);
		t.advance(1000);
		t.facts.busy = true;
		t.advance(1000);
		t.facts.asking = true;
		t.advance(1000);
		t.advance(1000);
		t.facts.asking = false;
		t.facts.busy = false;
		t.facts.idleMs = AUTO_INSTALL_IDLE_MS;
		t.advance(1000);
		expect(t.logs).toEqual([
			"waiting reason=focused+active input waitedMs=0",
			"waiting reason=busy turn waitedMs=2000",
			"waiting reason=open ask waitedMs=3000",
			"quiet waitedMs=5000 idleMs=120000 focused=true",
			"countdown restartAt=1065000",
		]);
	});

	it("logs the safe point a resume-on app installs at, and what holds it", () => {
		const t = setup({ busy: true, asking: true, focused: true, resumes: true });
		t.advance(0);
		t.advance(1000);
		t.facts.asking = false;
		t.advance(1000);
		t.facts.compacting = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(1000);
		t.facts.compacting = false;
		t.advance(1000);
		t.advance(0);
		expect(t.logs).toEqual([
			"waiting reason=open ask waitedMs=0",
			"safe waitedMs=2000 running=true resume=true",
			expect.stringMatching(/^countdown restartAt=\d+$/),
			"held reason=compaction",
			"install trigger=auto",
		]);
	});

	it("logs the forced install after 30 minutes past the user's Later with the resume setting", () => {
		const t = setup({ busy: true, focused: true, resumes: true });
		t.advance(0);
		t.scheduler.postpone();
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS - 1);
		expect(t.logs.slice(2)).toEqual(["postponed by=user", "waiting reason=busy turn waitedMs=0"]);
		t.advance(1);
		expect(t.logs.slice(4)).toEqual([
			`forced waitedMs=${AUTO_INSTALL_MAX_WAIT_MS} maxWaitMs=${AUTO_INSTALL_MAX_WAIT_MS} resume=true reason=busy turn`,
			expect.stringMatching(/^countdown restartAt=\d+$/),
		]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.advance(0);
		expect(t.logs.at(-1)).toBe("install trigger=auto");
	});

	it("never logs a forced install with resume off", () => {
		const t = setup({ busy: true, focused: true, resumes: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS * 2);
		expect(t.logs).toEqual(["waiting reason=busy turn waitedMs=0"]);
	});

	it("logs the user's Later, and waits again for a reason afterwards", () => {
		const t = setup({ focused: false, resumes: false });
		t.advance(0);
		t.scheduler.postpone();
		t.scheduler.postpone();
		t.facts.focused = true;
		t.advance(1000);
		t.advance(1000);
		expect(t.logs.map(line => line.split(" ")[0])).toEqual(["quiet", "countdown", "postponed", "waiting"]);
		expect(t.logs[2]).toBe("postponed by=user");
	});

	it("logs a withdrawal with its reason: work during a resume-off countdown, pref off, update gone", () => {
		const t = setup({ focused: false, resumes: false });
		t.advance(0);
		t.facts.busy = true;
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		t.facts.busy = false;
		t.advance(1000);
		t.facts.enabled = false;
		t.advance(1000);
		t.advance(1000);
		t.facts.enabled = true;
		t.facts.installable = false;
		t.advance(1000);
		t.facts.installable = true;
		t.advance(1000);
		t.facts.installable = false;
		t.advance(1000);
		const withdrawn = t.logs.filter(line => line.startsWith("withdrawn"));
		expect(withdrawn).toEqual([
			"withdrawn reason=work started, resume off",
			"withdrawn reason=pref off",
			"withdrawn reason=update not ready",
		]);
	});

	it("logs the wait reason again in a new round: the pref turned off and on, or the update gone and back", () => {
		const t = setup({ busy: true, asking: true, focused: true, resumes: true });
		t.advance(0);
		t.facts.enabled = false;
		t.advance(1000);
		t.facts.enabled = true;
		t.advance(1000);
		t.facts.installable = false;
		t.advance(1000);
		t.facts.installable = true;
		t.advance(1000);
		expect(t.logs).toEqual([
			"waiting reason=open ask waitedMs=0",
			"waiting reason=open ask waitedMs=0",
			"waiting reason=open ask waitedMs=0",
		]);
	});

	it("writes nothing with the pref off or no update ready", () => {
		const off = setup({ enabled: false });
		off.advance(0);
		off.advance(AUTO_INSTALL_MAX_WAIT_MS);
		const none = setup({ installable: false });
		none.advance(0);
		expect([...off.logs, ...none.logs]).toEqual([]);
	});
});
