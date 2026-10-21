import { describe, expect, it } from "vitest";
import { pointCommandAt } from "./autopilot-land-check";

describe("pointCommandAt", () => {
	const root = "C:\\Users\\me\\.omp\\wt\\run";
	const tree = "C:\\Temp\\land\\tree";

	it.each([
		["forward slashes", "cd C:/Users/me/.omp/wt/run && bun test", "cd C:/Temp/land/tree && bun test"],
		["Git Bash's drive form", "cd /c/Users/me/.omp/wt/run/src && ls", "cd /c/Temp/land/tree/src && ls"],
		["a quoted native path", 'cd "C:\\Users\\me\\.omp\\wt\\run" && ls', 'cd "C:\\Temp\\land\\tree" && ls'],
		["escaped backslashes", "cd C:\\\\Users\\\\me\\\\.omp\\\\wt\\\\run && ls", "cd C:\\\\Temp\\\\land\\\\tree && ls"],
		["a lower-case drive", "cd c:/Users/me/.omp/wt/run && ls", "cd c:/Temp/land/tree && ls"],
	])("points %s on Windows at the temporary checkout, spelled the same way", (_, command, expected) => {
		expect(pointCommandAt(command, root, tree, "win32")).toBe(expected);
	});

	it("finds a forward-slash root in a command that names it natively", () => {
		expect(pointCommandAt('cd "C:\\Users\\me\\.omp\\wt\\run"', "C:/Users/me/.omp/wt/run", tree, "win32")).toBe(
			`cd "${tree}"`,
		);
	});

	it("replaces the path as written elsewhere", () => {
		expect(pointCommandAt("cd /home/me/run && make", "/home/me/run", "/tmp/tree", "linux")).toBe(
			"cd /tmp/tree && make",
		);
	});
});
