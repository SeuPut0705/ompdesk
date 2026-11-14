import {
	type AutoInstallFacts,
	type AutoInstallLogDetails,
	type AutoInstallOptions,
	AutoInstallScheduler,
	type InstallTrigger,
} from "../../app-auto-update";

type Step =
	| { action: "reset" }
	| { action: "tick"; now: number; facts: AutoInstallFacts }
	| { action: "postpone"; now: number }
	| { action: "installStarted"; trigger: InstallTrigger };

const base: AutoInstallFacts = {
	enabled: true,
	installable: true,
	resumes: true,
	busy: false,
	focused: true,
	idleMs: 0,
};
const steps: Step[] = [
	{ action: "tick", now: 1000, facts: base },
	{ action: "postpone", now: 2000 },
	{ action: "tick", now: 2000, facts: { ...base, busy: true } },
	{ action: "tick", now: 1802000, facts: { ...base, busy: true } },
	{ action: "tick", now: 1862000, facts: { ...base, busy: true, asking: true } },
	{ action: "tick", now: 2462000, facts: { ...base, busy: true, asking: true, idleMs: 600000 } },
	{ action: "tick", now: 2522000, facts: { ...base, busy: true, asking: true, idleMs: 660000 } },
	{ action: "tick", now: 2523000, facts: base },
	{ action: "tick", now: 2524000, facts: { ...base, installable: false } },
	{ action: "tick", now: 2525000, facts: { ...base, startFailedBefore: true } },
	{ action: "tick", now: 2526000, facts: { ...base, startFailedBefore: true } },
	{ action: "tick", now: 2527000, facts: base },
	{ action: "installStarted", trigger: "user click" },
	{ action: "tick", now: 2590000, facts: base },
];

for (const resumes of [false, true]) {
	for (const hold of ["ask", "plan", "compaction"] as const) {
		const held = {
			...base,
			resumes,
			busy: true,
			asking: hold !== "compaction",
			planWaiting: hold === "plan",
			compacting: hold === "compaction",
		};
		steps.push(
			{ action: "reset" },
			{ action: "tick", now: 0, facts: held },
			{ action: "tick", now: 600_000, facts: { ...held, idleMs: 600_000 } },
			{ action: "tick", now: 660_000, facts: { ...held, idleMs: 660_000 } },
			{ action: "tick", now: 700_000, facts: { ...held, idleMs: 0 } },
			{ action: "tick", now: 1_300_000, facts: { ...held, idleMs: 600_000 } },
			{ action: "tick", now: 1_360_000, facts: { ...held, idleMs: 660_000 } },
			{ action: "tick", now: 1_400_000, facts: { ...base, resumes } },
			{ action: "tick", now: 1_460_000, facts: { ...base, resumes, focused: false } },
		);
	}
	steps.push(
		{ action: "reset" },
		{ action: "tick", now: 0, facts: { ...base, resumes, focused: false } },
		{ action: "tick", now: 60_000, facts: { ...base, resumes, busy: true } },
		{ action: "tick", now: 120_000, facts: { ...base, resumes, enabled: false } },
		{ action: "tick", now: 180_000, facts: { ...base, resumes, focused: false } },
		{ action: "installStarted", trigger: "quit" },
		{ action: "tick", now: 240_000, facts: { ...base, resumes } },
		{ action: "tick", now: 300_000, facts: { ...base, resumes, installable: false } },
		{ action: "tick", now: 360_000, facts: { ...base, resumes } },
	);
}

let now = 0;
let facts = base;
let effects: object[] = [];
const log = (event: string, details: AutoInstallLogDetails = {}) => effects.push({ type: "log", event, details });
const options: AutoInstallOptions = {
	now: () => now,
	facts: () => facts,
	log,
	effects: {
		announce: restartAt => effects.push({ type: "announce", restartAt }),
		withdraw: () => effects.push({ type: "withdraw" }),
		install: () => effects.push({ type: "install" }),
	},
};
let scheduler = new AutoInstallScheduler(options);
const captured = steps.map(step => {
	effects = [];
	if (step.action === "tick") {
		now = step.now;
		facts = step.facts;
		scheduler.tick();
	} else if (step.action === "postpone") {
		now = step.now;
		scheduler.postpone();
	} else if (step.action === "installStarted") scheduler.installStarted(step.trigger);
	else scheduler = new AutoInstallScheduler(options);
	return { ...step, effects, restartAt: scheduler.restartAt ?? null };
});
console.log(JSON.stringify(captured, null, 2));
