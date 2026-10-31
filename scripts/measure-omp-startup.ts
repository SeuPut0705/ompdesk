/**
 * How long the installed omp takes to start with the GUI bridge loaded, as OMPdesk's sidecar starts it.
 *
 *   bun scripts/measure-omp-startup.ts [--runs N] [--omp PATH] [--bridge PATH/index.ts] [--all]
 *
 * Per run: ms from spawn to stock's `ready` frame on stdout (what `SidecarManager` waits for, src/main/sidecar.ts
 * `#handleReady`) and to the answer of a `get_state` sent in the same tick as `ready`. The first run is a discarded
 * warm-up that fills bun's transpiler cache, so the numbers are a warm start. The bridge address is never connected:
 * area modules load at the bridge's first use, so this is omp's own start plus the bridge entry. The environment is
 * isolated like src/main/bridge-first-use-stock.test.ts (own agent dir, scripted provider models file, no spend).
 * `PI_DEBUG_STARTUP=1` makes stock print one `[startup]` line per phase on stderr; each is stamped with its arrival
 * time and reported as a median across the measured runs.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { newBridgeAddress, removeBridgeAddress } from "../src/main/bridge-client";

interface Run {
	readyMs: number;
	stateMs: number;
	phases: Array<{ text: string; ms: number }>;
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const omp = option("omp") ?? process.env.OMP_GUI_OMP ?? join(homedir(), ".bun", "bin", "omp");
const runs = Number(option("runs") ?? 10);
const bridgeEntry = option("bridge") ?? resolve(import.meta.dir, "../resources/gui-bridge/index.ts");

function summary(values: number[]): string {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
	return `median ${median.toFixed(0)} p90 ${p90.toFixed(0)} min ${sorted[0].toFixed(0)} max ${sorted[sorted.length - 1].toFixed(0)}`;
}

async function measureOnce(isolated: string, cwd: string): Promise<Run> {
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: join(isolated, "agent"),
		PI_CONFIG_DIR: isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_DEBUG_STARTUP: "1",
		PI_NO_PTY: "1",
		PI_NOTIFICATIONS: "off",
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	for (const key of Object.keys(env)) if (key.startsWith("OMP_GUI_")) Reflect.deleteProperty(env, key);
	env.OMP_GUI_BRIDGE = address;

	const started = performance.now();
	const child = spawn(
		omp,
		[
			"--mode",
			"rpc-ui",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			"fake/m1",
			"-e",
			bridgeEntry,
		],
		{ cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] },
	);
	const phases: Run["phases"] = [];
	let stderr = "";
	createInterface({ input: child.stderr }).on("line", line => {
		stderr += `${line}\n`;
		if (line.startsWith("[startup] "))
			phases.push({ text: line.slice("[startup] ".length), ms: performance.now() - started });
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const result = Promise.withResolvers<Run>();
	let readyMs = 0;
	createInterface({ input: child.stdout }).on("line", line => {
		let frame: { type?: string; id?: string; success?: boolean };
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (frame.type === "ready") {
			readyMs = performance.now() - started;
			child.stdin.write(`${JSON.stringify({ id: "s", type: "get_state" })}\n`);
		} else if (frame.type === "response" && frame.id === "s") {
			result.resolve({ readyMs, stateMs: performance.now() - started, phases });
		}
	});
	const timer = setTimeout(
		() => result.reject(new Error(`no get_state answer in 120 s: ${stderr.slice(-2000)}`)),
		120_000,
	);
	child.once("exit", code =>
		result.reject(new Error(`omp exited (${code}) before answering: ${stderr.slice(-2000)}`)),
	);
	try {
		return await result.promise;
	} finally {
		clearTimeout(timer);
		child.stdin.end();
		const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
		await exited.promise;
		clearTimeout(kill);
		removeBridgeAddress(address);
	}
}

const isolated = mkdtempSync(join(tmpdir(), "ompdesk-startup-"));
chmodSync(isolated, 0o700);
const agentDir = join(isolated, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
	join(agentDir, "models.yml"),
	"providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n",
);
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-startup-cwd-")));

try {
	await measureOnce(isolated, cwd);
	const measured: Run[] = [];
	for (let i = 0; i < runs; i += 1) measured.push(await measureOnce(isolated, cwd));

	console.log(`omp: ${omp}`);
	console.log(`bridge: ${bridgeEntry}`);
	console.log(`runs: ${runs} (after 1 discarded warm-up), ms from spawn`);
	measured.forEach((run, i) => {
		console.log(
			`run ${String(i + 1).padStart(2)}  ready ${run.readyMs.toFixed(0).padStart(5)}  get_state ${run.stateMs.toFixed(0).padStart(5)}`,
		);
	});
	console.log(`ready      ${summary(measured.map(run => run.readyMs))}`);
	console.log(`get_state  ${summary(measured.map(run => run.stateMs))}`);

	const detail = /^(capability|createTools):/;
	const byPhase = new Map<string, number[]>();
	for (const run of measured) {
		const seenInRun = new Map<string, number>();
		for (const { text, ms } of run.phases) {
			if (ms > run.readyMs || (!process.argv.includes("--all") && detail.test(text))) continue;
			const ordinal = (seenInRun.get(text) ?? 0) + 1;
			seenInRun.set(text, ordinal);
			const key = ordinal > 1 ? `${text} #${ordinal}` : text;
			byPhase.set(key, [...(byPhase.get(key) ?? []), ms]);
		}
	}
	console.log("startup phases before ready (stderr arrival, ms from spawn; --all adds capability:/createTools:):");
	for (const [text, values] of byPhase) console.log(`  ${summary(values)}  n=${values.length}  ${text}`);
} finally {
	rmSync(isolated, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
