/**
 * gui-bridge modes plumbing (resources/gui-bridge/modes/shared.ts): every modes
 * call runs `attach`, which must hook omp's extension events and each session's
 * stream once, not once per call (stock `on()` only appends handlers).
 *
 * Runs in Bun: the module's omp imports are type-only, which Bun erases, while
 * the GUI's tsc cannot resolve them.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SHARED = path.resolve("resources/gui-bridge/modes/shared.ts");

describe("gui-bridge modes attach", () => {
	it("registers the extension hooks and each session subscription once across repeated attach()", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-modes-shared-"));
		try {
			const script = `
import { attach, onHostInput, onSessionEvent, onSessionSwitch } from ${JSON.stringify(SHARED)};
const handlers = {};
const subscriptions = new Map();
const pi = { on: (event, handler) => (handlers[event] ??= []).push(handler) };
const sessionA = { subscribe: listener => subscriptions.set(sessionA, [...(subscriptions.get(sessionA) ?? []), listener]) };
const sessionB = { subscribe: listener => subscriptions.set(sessionB, [...(subscriptions.get(sessionB) ?? []), listener]) };
let live = sessionA;
const env = { pi, session: () => live, emit() {}, context() { throw new Error("none"); } };
const seen = { switches: 0, inputs: 0, events: 0 };
onSessionSwitch(() => seen.switches++);
onHostInput(() => seen.inputs++);
onSessionEvent(() => seen.events++);
for (let i = 0; i < 5; i++) attach(env);
live = sessionB;
for (let i = 0; i < 3; i++) attach(env);
for (const handler of handlers.session_switch) handler({ reason: "new" });
for (const handler of handlers.input) handler({ source: "rpc", text: "hi" });
for (const handler of handlers.input) handler({ source: "interactive", text: "local" });
for (const listener of subscriptions.get(sessionA)) listener({ type: "agent_start" });
console.log(JSON.stringify({
	sessionSwitch: handlers.session_switch.length,
	input: handlers.input.length,
	subscriptionsA: subscriptions.get(sessionA).length,
	subscriptionsB: subscriptions.get(sessionB).length,
	...seen,
}));
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			const output = execFileSync("bun", [path.join(dir, "check.ts")], { encoding: "utf8", timeout: 30_000 });
			expect(JSON.parse(output.trim())).toEqual({
				sessionSwitch: 1,
				input: 1,
				subscriptionsA: 1,
				subscriptionsB: 1,
				switches: 1,
				inputs: 1,
				events: 1,
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
