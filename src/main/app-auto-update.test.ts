import { describe, expect, it } from "vitest";
import {
	AUTO_INSTALL_COUNTDOWN_MS,
	AUTO_INSTALL_IDLE_MS,
	AUTO_INSTALL_MAX_WAIT_MS,
	type AutoInstallFacts,
	AutoInstallScheduler,
	quietMoment,
} from "./app-auto-update";

const MINUTE = 60 * 1000;

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
		advance(ms: number) {
			time += ms;
			scheduler.tick();
		},
	};
}

describe("quietMoment", () => {
	it("needs no running work, then either an unfocused app or two idle minutes", () => {
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
		expect(t.logs.map(line => line.split(" ")[0])).toEqual(["quiet", "countdown", "install"]);
	});

	it("treats no input for two minutes as idle even while focused", () => {
		const t = setup({ focused: true, idleMs: AUTO_INSTALL_IDLE_MS - 1 });
		t.advance(0);
		expect(t.calls).toEqual([]);
		t.facts.idleMs = AUTO_INSTALL_IDLE_MS;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
	});

	it("waits while a tab works, even unfocused", () => {
		const t = setup({ focused: false, busy: true });
		t.advance(0);
		t.advance(10 * MINUTE);
		expect(t.calls).toEqual([]);
		t.facts.busy = false;
		t.advance(1000);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
	});

	it("restarts after the max wait while still busy when work resumes after a restart", () => {
		const t = setup({ busy: true, focused: true, resumes: true });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS - 1);
		expect(t.calls).toEqual([]);
		t.advance(1);
		expect(t.calls).toEqual([`announce:${AUTO_INSTALL_COUNTDOWN_MS}`]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
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

describe("AutoInstallScheduler decision log", () => {
	it("writes each transition once, from busy through quiet and countdown to the install", () => {
		const t = setup({ focused: false, busy: true });
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
		const t = setup({ focused: true, busy: false, idleMs: 0 });
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

	it("logs the forced install after 30 minutes with the resume setting", () => {
		const t = setup({ busy: true, focused: true, resumes: true });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS - 1);
		expect(t.logs).toEqual(["waiting reason=busy turn waitedMs=0"]);
		t.advance(1);
		expect(t.logs.slice(1)).toEqual([
			`forced waitedMs=${AUTO_INSTALL_MAX_WAIT_MS} maxWaitMs=${AUTO_INSTALL_MAX_WAIT_MS} resume=true reason=busy turn`,
			expect.stringMatching(/^countdown restartAt=\d+$/),
		]);
		t.advance(AUTO_INSTALL_COUNTDOWN_MS);
		expect(t.logs.at(-1)).toBe("install trigger=auto");
	});

	it("never logs a forced install with resume off", () => {
		const t = setup({ busy: true, focused: true, resumes: false });
		t.advance(0);
		t.advance(AUTO_INSTALL_MAX_WAIT_MS * 2);
		expect(t.logs).toEqual(["waiting reason=busy turn waitedMs=0"]);
	});

	it("logs the user's Later, and waits again for a reason afterwards", () => {
		const t = setup({ focused: false });
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

	it("writes nothing with the pref off or no update ready", () => {
		const off = setup({ enabled: false });
		off.advance(0);
		off.advance(AUTO_INSTALL_MAX_WAIT_MS);
		const none = setup({ installable: false });
		none.advance(0);
		expect([...off.logs, ...none.logs]).toEqual([]);
	});
});
