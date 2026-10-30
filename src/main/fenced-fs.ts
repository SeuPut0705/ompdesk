/**
 * `original-fs`'s promises, fenced to the serial-chain step they are called in (see `fencedEffect`): inside a
 * `withRepoLock` callback that ran past its bound, every call throws before it starts and again as soon as it
 * returns, so a stalled holder that resumes cannot remove, rename, write, link or copy anything on the next
 * holder's state (a `realpath` that answers late is followed by an `rm` that never runs). A call the OS already has
 * when the step is stopped is tracked: the lock is not handed on until it settled. Outside any step it is exactly
 * `original-fs`'s promises. The one choke point: a module whose code runs under a lock imports `fs` from here.
 */
import { promises as real } from "original-fs";
import { fencedEffect } from "./serial-chain";

export const fs: typeof real = new Proxy(real, {
	get(target, name) {
		const member = Reflect.get(target, name);
		if (typeof member !== "function") return member;
		// Looked up again at the call: a replaced member (a test's spy) is the one that runs.
		return fencedEffect(`fs.${String(name)}`, (...args: unknown[]) => Reflect.get(target, name).apply(target, args));
	},
});
