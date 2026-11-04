import { describe, expect, it } from "vitest";
import { type EngineFacts, engineAction } from "./local-engines-core";

const facts = (over: Partial<EngineFacts>): EngineFacts => ({
	up: false,
	present: false,
	registered: false,
	removed: false,
	...over,
});

describe("engineAction", () => {
	it("registers an engine that answers when nothing of that id exists and the person never removed it", () => {
		expect(engineAction(facts({ up: true }))).toBe("register");
	});

	it("never registers an engine the person removed, however long it answers", () => {
		expect(engineAction(facts({ up: true, removed: true }))).toBe("none");
	});

	it("reads a vanished entry of ours as the person deleting it, up or down", () => {
		expect(engineAction(facts({ registered: true, up: true }))).toBe("tombstone");
		expect(engineAction(facts({ registered: true, up: false }))).toBe("tombstone");
	});

	it("unregisters our entry once the engine stops answering, without a tombstone", () => {
		expect(engineAction(facts({ present: true, registered: true, up: false }))).toBe("unregister");
	});

	it("keeps our entry while the engine answers", () => {
		expect(engineAction(facts({ present: true, registered: true, up: true }))).toBe("none");
	});

	it("never touches an entry of the same id the person made", () => {
		for (const up of [true, false]) {
			for (const removed of [true, false]) {
				expect(engineAction(facts({ present: true, up, removed }))).toBe("none");
			}
		}
	});

	it("does nothing for an engine that is down and absent", () => {
		expect(engineAction(facts({}))).toBe("none");
		expect(engineAction(facts({ removed: true }))).toBe("none");
	});
});
