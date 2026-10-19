import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the bridge's idle compaction timer (resources/gui-bridge/idle-compaction-core.ts) to the installed omp, in an
 * empty private agent dir (no model is called): the `idleCompaction` feature is available (every internal it reads
 * exists, none of them a separate copy), the live session exposes `promptCacheEntry`, and stock's
 * `getCacheWarmingDelayMs` gives the refresh points the unit tests' stand-in uses.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { getCacheWarmingDelayMs } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { probe } from "./health";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const out = {};
   out.unavailable = (await probe({ pi, session: () => session }, ["idleCompaction"])).map(e => ({ feature: e.feature, missing: e.missing }));
   out.hasEntry = "promptCacheEntry" in session;
   out.delays = [5_000, 10_000, 10_001, 300_000, 3_600_000].map(ttl => [ttl, getCacheWarmingDelayMs(ttl) ?? null]);
   console.error("IDLE_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("IDLE_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	hasEntry: boolean;
	delays: Array<[number, number | null]>;
}

function run(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-idle-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "idle-probe.ts"), PROBE);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
		};
		const result = spawnSync(
			omp,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(bridge, "idle-probe.ts"),
			],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("IDLE_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^IDLE_PROBE=/);
		return JSON.parse(line?.slice("IDLE_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("idle compaction on stock omp", () => {
	it("reads the session's prompt cache entry and stock's refresh point", () => {
		const out = run();
		expect(out.unavailable).toEqual([]);
		expect(out.hasEntry).toBe(true);
		// The stand-in in bridge-idle-compaction.test.ts.
		const standIn = (ttlMs: number) =>
			ttlMs <= 10_000 ? null : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
		expect(out.delays).toEqual(out.delays.map(([ttl]) => [ttl, standIn(ttl)]));
	}, 150_000);
});
