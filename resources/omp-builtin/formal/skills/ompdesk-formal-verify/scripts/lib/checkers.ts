import fs from "node:fs";
import path from "node:path";
import { parseCfg } from "./cfg";
import { checkLean } from "./lean-trust";
import type { Checker, CheckerSpec, CheckOutcome } from "./mutate-core";
import { run, Unavailable } from "./proc";
import { prepareTla, type TlaEnv } from "./tla-env";
import { runTlc } from "./tlc-run";

/**
 * The folder to copy for each mutation: `checker.root` or the Lean `project` (relative to the mutations file's
 * folder), else the model's own folder.
 */
export function checkerRoot(spec: CheckerSpec, modelDir: string, mutationsDir: string): string {
	if (spec.root) return path.resolve(mutationsDir, spec.root);
	if (spec.kind === "lean") return path.resolve(mutationsDir, spec.project ?? ".");
	return modelDir;
}

/** The properties a TLC config asks TLC to check: INVARIANT and PROPERTY names. */
export function cfgProperties(configPath: string): string[] {
	const info = parseCfg(fs.readFileSync(configPath, "utf8"));
	return [...info.invariants, ...info.properties];
}

function tlcChecker(spec: Extract<CheckerSpec, { kind: "tlc" }>): Checker {
	let prepared: TlaEnv | undefined;
	return async (_dir, model, mutation) => {
		let tla: TlaEnv;
		try {
			prepared ??= await prepareTla();
			tla = prepared;
		} catch (error) {
			if (error instanceof Unavailable) return { status: "unavailable", violated: [], detail: error.message };
			throw error;
		}
		const configName = mutation?.config ?? spec.config ?? `${path.basename(model, ".tla")}.cfg`;
		const config = path.join(path.dirname(model), configName);
		if (!fs.existsSync(config)) return { status: "error", violated: [], detail: `config not found: ${configName}` };
		const tlcRun = await runTlc({
			tla,
			spec: model,
			config,
			workers: spec.workers,
			timeoutMs: (spec.timeoutSec ?? 180) * 1000,
		});
		if (tlcRun.spawnError)
			return { status: "unavailable", violated: [], detail: `java could not be started: ${tlcRun.spawnError}` };
		const { result } = tlcRun;
		if (result.outcome === "pass") return { status: "pass", violated: [], detail: "no violation" };
		if (["invariant", "action", "temporal", "deadlock", "assert"].includes(result.outcome)) {
			let named = result.outcome === "deadlock" ? "deadlock" : result.property;
			if (!named && result.outcome !== "assert") {
				// TLC names a violated refinement or old-style temporal property only as "Temporal properties were
				// violated": with a single INVARIANT/PROPERTY in the config there is no doubt which one failed.
				const listed = cfgProperties(config);
				if (listed.length === 1) named = listed[0];
			}
			return {
				status: "fail",
				violated: named ? [named] : [],
				detail: `${result.outcome}${result.property ? ` ${result.property}` : ""}`,
			};
		}
		return {
			status: "error",
			violated: [],
			detail: `${result.outcome}: ${result.message ?? result.errors[0] ?? tlcRun.text.trim().split(/\r?\n/).slice(-3).join(" ")}`,
		};
	};
}

function leanChecker(spec: Extract<CheckerSpec, { kind: "lean" }>): Checker {
	return async dir => {
		const check = await checkLean(dir, { allowNative: spec.allowNative });
		if (check.status === "unavailable") return { status: "unavailable", violated: [], detail: check.detail };
		if (check.status === "pass") return { status: "pass", violated: [], detail: "build and trust audit are clean" };
		if (check.status === "error") return { status: "error", violated: [], detail: check.detail };
		// An unknown identifier or an unexpected token is a broken model, not a property that failed.
		if (check.invalid.length > 0) {
			const first = check.invalid[0] as (typeof check.invalid)[number];
			return {
				status: "error",
				violated: [],
				detail: `the mutated model no longer elaborates: ${first.file}:${first.line}: ${first.message.split("\n")[0]}`,
			};
		}
		return { status: "fail", violated: check.violated, detail: check.detail };
	};
}

/** A custom checker: prints `VIOLATED: <name>` lines and exits 0 pass, 1 fail, 2 error, 3 unavailable. */
function commandChecker(spec: Extract<CheckerSpec, { kind: "command" }>): Checker {
	return async (dir, model) => {
		const [program, ...args] = spec.command.map(part => part.replaceAll("{dir}", dir).replaceAll("{model}", model));
		const result = await run(program as string, args, { cwd: dir, timeoutMs: 30 * 60_000 });
		const text = `${result.stdout}${result.stderr}`;
		if (result.spawnError)
			return { status: "error", violated: [], detail: `cannot run ${program}: ${result.spawnError.message}` };
		const violated = [...result.stdout.matchAll(/^VIOLATED:\s*(.+?)\s*$/gm)].map(match => match[1] as string);
		const outcome = (status: CheckOutcome["status"]): CheckOutcome => ({
			status,
			violated,
			detail: text.trim().split(/\r?\n/).slice(-3).join(" | "),
		});
		if (result.code === 0) return outcome("pass");
		if (result.code === 1) return outcome("fail");
		if (result.code === 3) return outcome("unavailable");
		return outcome("error");
	};
}

export function makeChecker(spec: CheckerSpec): Checker {
	if (spec.kind === "tlc") return tlcChecker(spec);
	if (spec.kind === "lean") return leanChecker(spec);
	return commandChecker(spec);
}
