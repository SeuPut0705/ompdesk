/**
 * Windows: a lid close follows the power scheme's "lid close action". While work runs on AC, the active scheme's AC
 * value is set to 0 (do nothing) with `powercfg` (no admin needed) and the user's own value is put back when it
 * stops. The battery (DC) value is never touched, and a user who already chose "do nothing" is left alone. The value
 * changed is written to `markerFile` before the change, so a crash or kill is undone at the next launch.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { LidBackend, LidHoldOutcome } from "./lid-awake";

/** `SUB_BUTTONS` and `LIDACTION` by GUID: the aliases are English only in some powercfg builds. */
const SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";
const LIDACTION = "5ca83367-6e45-459f-a27b-476b1d01c936";
const DO_NOTHING = 0;

export interface PowercfgRunner {
	/** `powercfg <args>`, its stdout; rejects on a non-zero exit. */
	run(args: readonly string[]): Promise<string>;
	runSync(args: readonly string[]): string;
}

export interface WindowsLidOptions {
	powercfg: PowercfgRunner;
	/** At least one battery (Win32_Battery): a desktop has no lid to close. */
	hasBattery: () => Promise<boolean>;
	markerFile: string;
	now: () => number;
}

/** What this process changed: the scheme and the AC value it had. */
export interface LidMarker {
	scheme: string;
	ac: number;
	at: number;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The active scheme's GUID from `powercfg /getactivescheme`. */
export function parseActiveScheme(output: string): string {
	const scheme = GUID.exec(output)?.[0];
	if (!scheme) throw new Error(`powercfg /getactivescheme: no scheme GUID in ${JSON.stringify(output.slice(0, 200))}`);
	return scheme.toLowerCase();
}

/**
 * The AC value from `powercfg /query <scheme> <sub> <setting>`. The labels are localized ("Current AC Power Setting
 * Index", "현재 AC 전원 설정 인덱스"), so it reads the two `0x` values an index setting prints, AC first, then DC.
 */
export function parseAcValue(output: string): number {
	const values = [...output.matchAll(/:\s*0x([0-9a-f]+)\s*$/gim)].map(match => Number.parseInt(match[1] ?? "", 16));
	if (values.length !== 2) throw new Error(`powercfg /query: expected AC and DC values, found ${values.length}`);
	return values[0] ?? DO_NOTHING;
}

const queryArgs = (scheme: string) => ["/query", scheme, SUB_BUTTONS, LIDACTION];

/**
 * The commands that put `marker`'s value back, given the scheme's current query output: none when the user changed the
 * value themselves meanwhile (it no longer reads "do nothing").
 */
export function restoreCommands(marker: LidMarker, currentQuery: string): string[][] {
	if (parseAcValue(currentQuery) !== DO_NOTHING) return [];
	return [
		["/setacvalueindex", marker.scheme, SUB_BUTTONS, LIDACTION, String(marker.ac)],
		["/setactive", "SCHEME_CURRENT"],
	];
}

export class WindowsLidBackend implements LidBackend {
	readonly name = "powercfg";
	readonly #options: WindowsLidOptions;
	#held: LidMarker | undefined;

	constructor(options: WindowsLidOptions) {
		this.#options = options;
	}

	isLaptop(): Promise<boolean> {
		return this.#options.hasBattery();
	}

	async recover(): Promise<Record<string, unknown> | null> {
		const marker = this.#readMarker();
		if (!marker) return null;
		const { run } = this.#options.powercfg;
		const commands = restoreCommands(marker, await run(queryArgs(marker.scheme)));
		for (const command of commands) await run(command);
		this.#removeMarker();
		return { scheme: marker.scheme, ac: marker.ac, restored: commands.length > 0 };
	}

	async hold(): Promise<LidHoldOutcome> {
		const { run } = this.#options.powercfg;
		const scheme = parseActiveScheme(await run(["/getactivescheme"]));
		const ac = parseAcValue(await run(queryArgs(scheme)));
		if (ac === DO_NOTHING) return { changed: false, details: { scheme, ac } };
		const marker: LidMarker = { scheme, ac, at: this.#options.now() };
		this.#writeMarker(marker);
		this.#held = marker;
		await run(["/setacvalueindex", scheme, SUB_BUTTONS, LIDACTION, String(DO_NOTHING)]);
		await run(["/setactive", "SCHEME_CURRENT"]);
		return { changed: true, details: { scheme, ac } };
	}

	async release(): Promise<void> {
		const marker = this.#held;
		this.#held = undefined;
		if (!marker) return;
		const { run } = this.#options.powercfg;
		for (const command of restoreCommands(marker, await run(queryArgs(marker.scheme)))) await run(command);
		this.#removeMarker();
	}

	releaseNow(): void {
		const marker = this.#held;
		this.#held = undefined;
		if (!marker) return;
		const { runSync } = this.#options.powercfg;
		for (const command of restoreCommands(marker, runSync(queryArgs(marker.scheme)))) runSync(command);
		this.#removeMarker();
	}

	#readMarker(): LidMarker | null {
		let text: string;
		try {
			text = readFileSync(this.#options.markerFile, "utf8");
		} catch {
			return null;
		}
		try {
			const value: unknown = JSON.parse(text);
			if (
				typeof value === "object" &&
				value !== null &&
				"scheme" in value &&
				typeof value.scheme === "string" &&
				GUID.test(value.scheme) &&
				"ac" in value &&
				typeof value.ac === "number" &&
				Number.isInteger(value.ac) &&
				value.ac >= 0
			) {
				return {
					scheme: value.scheme,
					ac: value.ac,
					at: "at" in value && typeof value.at === "number" ? value.at : 0,
				};
			}
		} catch {}
		// Unreadable: nothing to restore from; never guess a value.
		this.#removeMarker();
		return null;
	}

	#writeMarker(marker: LidMarker): void {
		const file = this.#options.markerFile;
		writeFileSync(`${file}.tmp`, JSON.stringify(marker));
		renameSync(`${file}.tmp`, file);
	}

	#removeMarker(): void {
		rmSync(this.#options.markerFile, { force: true });
	}
}
