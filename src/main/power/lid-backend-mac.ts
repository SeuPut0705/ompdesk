/**
 * macOS: stock `/usr/bin/caffeinate -s -w <pid>` holds a PreventSystemSleep assertion, which macOS honours only on AC
 * power, for as long as it runs; `-w` ends it with OMPdesk's main process, so a crash or kill leaves nothing held.
 * No admin rights and no `pmset disablesleep`. Whether that assertion alone keeps a MacBook awake with its lid closed
 * and no external display is the one fact this route rests on; only this file changes if it needs another.
 */

import type { LidBackend, LidHoldOutcome } from "./lid-awake";

export interface CaffeinateHandle {
	stop(): void;
}

export interface MacLidOptions {
	/** Start `caffeinate -s -w <pid>`. */
	caffeinate: () => CaffeinateHandle;
	/** `pmset -g batt`. */
	batteryReport: () => Promise<string>;
}

export class MacLidBackend implements LidBackend {
	readonly name = "caffeinate";
	readonly #options: MacLidOptions;
	#handle: CaffeinateHandle | undefined;

	constructor(options: MacLidOptions) {
		this.#options = options;
	}

	async isLaptop(): Promise<boolean> {
		return (await this.#options.batteryReport()).includes("InternalBattery");
	}

	async recover(): Promise<null> {
		return null;
	}

	async hold(): Promise<LidHoldOutcome> {
		this.#handle ??= this.#options.caffeinate();
		return { changed: true };
	}

	async release(): Promise<void> {
		this.releaseNow();
	}

	releaseNow(): void {
		this.#handle?.stop();
		this.#handle = undefined;
	}
}
