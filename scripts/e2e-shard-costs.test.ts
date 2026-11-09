import { expect, it } from "vitest";
import { parseSpecSeconds } from "./e2e-shard-costs";

it("sums each spec file's test times from a shard's log, passed or failed, in ms, s and m", () => {
	const ESC = "\x1b";
	const log = [
		`e2e (shard 1/5)\tUNKNOWN STEP\t2026-11-09T11:40:00.0Z   ${ESC}[32m✓${ESC}[39m  ${ESC}[2m12 e2e/smoke.e2e.ts:59:1 › launches and shows the composer${ESC}[22m${ESC}[2m (13.4s)${ESC}[22m`,
		"e2e (shard 1/5)\tUNKNOWN STEP\t2026-11-09T11:41:00.0Z   ✓  13 e2e/smoke.e2e.ts:80:1 › a second window (850ms)",
		"e2e (shard 1/5)\tUNKNOWN STEP\t2026-11-09T11:42:00.0Z   ✘  14 e2e/phone-host-rows.e2e.ts:159:1 › rows follow the host (1.1m)",
		"e2e (shard 1/5)\tUNKNOWN STEP\t2026-11-09T11:43:00.0Z   -  15 e2e/real-work-map.e2e.ts:20:1 › opt-in audit",
		"e2e (shard 1/5)\tUNKNOWN STEP\t2026-11-09T11:44:00.0Z   2 passed (15.4m)",
	].join("\n");
	const seconds = parseSpecSeconds(log);
	expect([...seconds.keys()]).toEqual(["smoke.e2e.ts", "phone-host-rows.e2e.ts"]);
	expect(seconds.get("smoke.e2e.ts")).toBeCloseTo(14.25);
	expect(seconds.get("phone-host-rows.e2e.ts")).toBeCloseTo(66);
});
