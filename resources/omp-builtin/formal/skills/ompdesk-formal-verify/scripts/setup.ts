#!/usr/bin/env bun
// Prepares the verification tools in the user cache (no sudo, nothing system-wide): `tla` is TLC (pinned
// tla2tools.jar, CommunityModules, a portable Java only when no working java), `lean` is elan plus the pinned Lean
// toolchain (no Mathlib). Lazy and idempotent: a present, hash-matching file is never fetched again.
//
//   bun setup.ts tla|lean [--check] [--json]
//
// Exit: 0 READY, 2 usage, 3 UNAVAILABLE (a tool is missing and could not be prepared: report "not checked").
import { cacheRoot } from "./lib/cache";
import { leanStatus, prepareLean } from "./lib/lean-env";
import { EXIT, Unavailable, UsageError } from "./lib/proc";
import { prepareTla, tlaStatus } from "./lib/tla-env";

const USAGE = "usage: bun setup.ts tla|lean [--check] [--json]";

interface Parsed {
	target: "tla" | "lean";
	check: boolean;
	json: boolean;
}

export function parseArgs(argv: string[]): Parsed {
	let target: Parsed["target"] | undefined;
	let check = false;
	let json = false;
	for (const arg of argv) {
		if (arg === "--check") check = true;
		else if (arg === "--json") json = true;
		else if (arg === "tla" || arg === "lean") target = arg;
		else throw new UsageError(`unknown argument ${arg}\n${USAGE}`);
	}
	if (!target) throw new UsageError(USAGE);
	return { target, check, json };
}

async function main(): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const say = (text: string): void => console.log(text);
	const unavailable = (reason: string, hint: string[]): number => {
		if (parsed.json) say(JSON.stringify({ status: "UNAVAILABLE", target: parsed.target, reason }));
		else {
			say(`UNAVAILABLE ${parsed.target}: ${reason}`);
			for (const line of hint) say(line);
		}
		return EXIT.unavailable;
	};
	try {
		if (parsed.target === "tla") {
			if (parsed.check) {
				const status = await tlaStatus();
				if (!status.ready) {
					return unavailable(`not installed (${status.missing.join(", ")}); run: bun setup.ts tla`, []);
				}
			}
			const env = await prepareTla();
			if (parsed.json) say(JSON.stringify({ status: "READY", target: "tla", ...env, cache: cacheRoot() }));
			else {
				say("READY tla");
				say(`  java:       ${env.java} (${env.javaSource}, Java ${env.javaMajor})`);
				say(`  tla2tools:  ${env.tla2tools} (${env.tlaVersion})`);
				say(`  community:  ${env.community} (${env.communityVersion})`);
			}
			return EXIT.ok;
		}
		if (parsed.check) {
			const status = leanStatus();
			if (!status.ready) {
				return unavailable(`not installed (${status.missing.join(", ")}); run: bun setup.ts lean`, []);
			}
		}
		const env = await prepareLean({ log: line => console.error(line) });
		if (parsed.json) {
			say(
				JSON.stringify({
					status: "READY",
					target: "lean",
					lake: env.lake,
					lean: env.lean,
					toolchain: env.toolchain,
					version: env.leanVersion,
					elanHome: env.elanHome,
					source: env.source,
				}),
			);
		} else {
			say("READY lean");
			say(`  lake:       ${env.lake} (${env.source})`);
			say(`  lean:       ${env.leanVersion} (${env.toolchain})`);
			if (env.elanHome) say(`  ELAN_HOME:  ${env.elanHome}`);
		}
		return EXIT.ok;
	} catch (error) {
		if (error instanceof Unavailable) {
			return unavailable(error.message, [
				"  Report this check as not run. Install by hand (Java 11+ / elan) or retry with network access.",
			]);
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main());
