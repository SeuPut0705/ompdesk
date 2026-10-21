import { describe, expect, it } from "vitest";
import { findUnhandledCalls } from "./lint-unhandled.mjs";

describe("lint-unhandled", () => {
	it("flags a void window.omp call whose rejection nobody handles", () => {
		const source = `
const a = () => void window.omp.system.openExternal(url);
function b() { void window.omp.prefs.get(key).then(value => set(value)); }
const c = <button onClick={() => void window.omp.updater.apply()} />;
function d() { void tabRpc.cancelLogin(url); }
`;
		expect(findUnhandledCalls(source).map(hit => hit.line)).toEqual([2, 3, 4, 5]);
	});

	it("accepts .catch, a two-argument .then, a catch after finally, and an unhandled-ok escape", () => {
		const source = `
void window.omp.prefs.get(key).catch(() => undefined);
void window.omp.prefs.get(key).then(set, () => undefined);
void window.omp.prefs.get(key).finally(done).catch(report);
// unhandled-ok: main never rejects this one
void window.omp.runtime.report(entry);
`;
		expect(findUnhandledCalls(source)).toEqual([]);
	});

	it("leaves calls that are not window.omp alone", () => {
		const source = `
void rpc.refresh();
void load();
void window.location.reload();
`;
		expect(findUnhandledCalls(source)).toEqual([]);
	});
});
