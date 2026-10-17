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
	const scheduler = new AutoInstallScheduler({
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
