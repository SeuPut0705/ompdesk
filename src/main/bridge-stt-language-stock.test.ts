import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_FALLBACK_STT_MODEL, MODEL_LANGUAGES } from "../../resources/gui-bridge/stt-language-core";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Dictation's model choice (resources/gui-bridge/voice.ts) on the installed omp: every stock internal the voice methods
 * need resolves, the language table names stock's own catalog, and, when the dictation model is already in the user's
 * cache, `stt_prepare` answers it ready. Nothing is downloaded: without the cached model that test skips.
 */
const userAgentCache = join(homedir(), ".omp", "agent", "cache");

const PROBE = `
import { methods } from "./voice";
import { probe } from "./health";
import { isSttModelCached } from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { DEFAULT_STT_MODEL_KEY, STT_MODELS } from "@oh-my-pi/pi-coding-agent/stt/models";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   out.unavailable = await probe(env, ["voice"]);
   out.cached = await isSttModelCached(DEFAULT_STT_MODEL_KEY);
   out.catalog = STT_MODELS.map(model => ({ key: model.key, englishOnly: model.englishOnly, description: model.description }));
   if (out.cached && out.unavailable.length === 0) out.preparedEn = await methods.stt_prepare({ language: "en" }, env);
  } catch (err) {
   out.error = String((err && err.stack) || err);
  }
  console.error("VOICE_PROBE=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface Probe {
	unavailable?: Array<{ feature: string; missing: string[] }>;
	cached?: boolean;
	catalog?: Array<{ key: string; englishOnly: boolean; description: string }>;
	preparedEn?: unknown;
	error?: string;
}

function run<T>(source: string, marker: string, timeout: number): T {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-stt-language-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		writeFileSync(join(isolated, "bridge", "voice-probe.ts"), source);
		// The user's model cache: the isolated agent dir would otherwise look like a machine with no model.
		if (existsSync(userAgentCache)) symlinkSync(userAgentCache, join(isolated, "cache"));
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			// The setting's English, whatever conversation language the shell running vitest carries.
			OMP_GUI_REPLY_LANGUAGE: "",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY"])
			Reflect.deleteProperty(env, key);
		const result = spawnSync(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(isolated, "bridge", "voice-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith(`${marker}=`));
		expect(line, result.stderr.slice(-2500)).toMatch(new RegExp(`^${marker}=`));
		return JSON.parse(line?.slice(marker.length + 1) ?? "{}") as T;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("dictation's model, on stock omp", () => {
	let probe: Probe;
	beforeAll(() => {
		probe = run<Probe>(PROBE, "VOICE_PROBE", 170_000);
	}, 180_000);

	it("finds every stock internal the voice methods need", () => {
		expect(probe.error).toBeUndefined();
		expect(probe.unavailable).toEqual([]);
	});

	it("names only stock's catalog models in its language table, as many languages as stock says", () => {
		const catalog = probe.catalog ?? [];
		for (const [key, languages] of Object.entries(MODEL_LANGUAGES)) {
			const entry = catalog.find(model => model.key === key);
			expect(entry, key).toMatchObject({ englishOnly: false });
			expect(Number(/(\d+) languages/.exec(entry?.description ?? "")?.[1]), key).toBe(languages.length);
		}
		const fallback = catalog.find(model => model.key === LANGUAGE_FALLBACK_STT_MODEL);
		expect(fallback).toMatchObject({ englishOnly: false, description: expect.stringMatching(/99 languages/) });
	});

	it("prepares English on the cached default model at once", ctx => {
		if (!probe.cached) ctx.skip();
		expect(probe.preparedEn).toEqual({ language: "en", modelKey: "parakeet-tdt-0.6b-v3", state: "ready" });
	});
});
