import { describe, expect, it } from "vitest";
import { descendantsIn, processKey, processTree, type WinProcess } from "./process-tree";

const proc = (pid: number, ppid: number, created: number): WinProcess => ({
	pid,
	ppid,
	threads: 1,
	name: "electron.exe",
	exe: "node_modules/electron/dist/electron.exe",
	commandLine: null,
	created: String(created),
});

const pids = (found: WinProcess[]) => found.map(entry => entry.pid).sort((a, b) => a - b);

describe("descendantsIn", () => {
	const main = proc(100, 1, 1000);
	const gpu = proc(101, 100, 1001);

	it("finds what the app started after the snapshot through a main that has exited, and what that started", () => {
		const supervisor = proc(300, 100, 1500);
		const installer = proc(301, 300, 1600);
		const now = [gpu, supervisor, installer, proc(9, 1, 1)];
		expect(pids(descendantsIn(now, [main, gpu]))).toEqual([101, 300, 301]);
	});

	it("leaves alone another run's app of the same binary: one a killed worker left running, one running beside", () => {
		const orphan = proc(200, 50, 500);
		const orphanHelper = proc(201, 200, 501);
		const neighbour = proc(210, 60, 1200);
		const neighbourHelper = proc(211, 210, 1201);
		const now = [proc(60, 1, 10), orphan, orphanHelper, neighbour, neighbourHelper, gpu];
		expect(pids(descendantsIn(now, [main, gpu]))).toEqual([101]);
	});

	it("does not take a process that holds the main's pid now, nor its children", () => {
		const reused = proc(100, 7, 2000);
		const reusedChild = proc(400, 100, 2001);
		const lastWords = proc(401, 100, 1900);
		expect(pids(descendantsIn([reused, reusedChild, lastWords], [main]))).toEqual([401]);
	});

	it("names a process by pid and creation time", () => {
		expect(processKey(main)).toBe("100@1000");
		expect(processKey(proc(100, 7, 2000))).not.toBe(processKey(main));
	});
});

describe("processTree", () => {
	it("is the root and everything below it, never a child older than its parent", () => {
		const all = [proc(1, 0, 10), proc(2, 1, 20), proc(3, 2, 30), proc(4, 2, 5), proc(5, 9, 40)];
		expect(pids(processTree(all, 1))).toEqual([1, 2, 3]);
	});
});
