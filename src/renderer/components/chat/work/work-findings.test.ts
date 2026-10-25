import { describe, expect, it } from "vitest";
import { type CheckInput, checkKind, commandOperation, summarizeChecks, unresolvedFailures } from "./work-checks";
import { deriveFindings, operationLabel, workSummaryText } from "./work-findings";

function bash(command: string, text: string, exitCode: number, toolCallId: string, previewUrl?: string) {
	return {
		command,
		text,
		exitCode,
		failed: exitCode !== 0,
		toolCallId,
		...(previewUrl ? { previewUrl } : {}),
	} satisfies CheckInput & { previewUrl?: string };
}

function derive(commands: ReturnType<typeof bash>[], failedStep?: string, running = false) {
	const failures = unresolvedFailures(commands.map(commandOperation)).filter(command => !checkKind(command.command));
	return deriveFindings({ running, checks: summarizeChecks(commands), failures, commands, failedStep });
}

describe("deriveFindings", () => {
	it("passes no verdict for a passing check: the card's metric strip reads the checks itself", () => {
		expect(derive([bash("bunx vitest run", " Tests  128 passed (128)", 0, "t1")])).toEqual({});
	});

	it("points a failing check at its call with the cause", () => {
		expect(
			derive([
				bash("bun run check:types", "src/a.ts(1,1): error TS2322: nope\nerror: script exited with code 2", 2, "c1"),
			]),
		).toEqual({ error: { cause: "src/a.ts(1,1): error TS2322: nope", toolCallId: "c1" } });
	});

	it("names a failed command that is no check, and falls back to the first failed step of any tool", () => {
		expect(derive([bash("node build.js", "Error: ENOENT: no such file", 1, "n1")]).error).toEqual({
			cause: "Error: ENOENT: no such file",
			toolCallId: "n1",
		});
		expect(derive([bash("ls", "a", 0, "l1")], "edit-1").error).toEqual({ toolCallId: "edit-1" });
		expect(derive([], undefined).error).toBeUndefined();
	});

	it("has no verdict for a command a later run of the same command fixed", () => {
		expect(
			derive([bash("git push origin main", "rejected", 1, "p1"), bash("git push origin main", "ok", 0, "p2")]),
		).toEqual({});
	});

	it("takes the last dev server's address", () => {
		expect(
			derive([
				bash("npm run dev", "Local: http://localhost:5173/", 0, "s1", "http://localhost:5173/"),
				bash("npm run dev -- --port 3000", "Local: http://localhost:3000/", 0, "s2", "http://localhost:3000/"),
			]).previewUrl,
		).toBe("http://localhost:3000/");
	});

	it("concludes nothing while the card runs", () => {
		expect(derive([bash("npm test", "5 passed", 0, "t1")], "x", true)).toEqual({});
	});
});

describe("workSummaryText", () => {
	const labels = {
		cause: "Cause",
		changed: "Changed files (2)",
		checks: "Checks",
		recovered: "Failed, then fixed",
		preview: "Preview",
		deleted: "deleted",
	};

	it("writes the head, the cause, the changed files with their lines, the checks and the preview as plain text", () => {
		expect(
			workSummaryText({
				head: "Ship the card\n12s · 2 files changed +4 −1",
				cause: "error TS2322: nope",
				files: [
					{ path: "src/a.ts", added: 3, removed: 1 },
					{ path: "src/old.ts", deleted: true },
				],
				checks: [
					{ passed: false, label: "type check failed" },
					{ passed: true, label: "128 tests passed" },
				],
				recovered: ["edit src/a.ts"],
				previewUrl: "http://localhost:5173/",
				labels,
			}),
		).toBe(
			[
				"Ship the card\n12s · 2 files changed +4 −1",
				"Cause: error TS2322: nope",
				"Changed files (2)\n- src/a.ts +3 -1\n- src/old.ts (deleted)",
				"Checks\n- ✕ type check failed\n- ✓ 128 tests passed",
				"Failed, then fixed\n- ✕ → ✓ edit src/a.ts",
				"Preview: http://localhost:5173/",
			].join("\n\n"),
		);
	});

	it("leaves out what the run did not have", () => {
		expect(
			workSummaryText({ head: "3 commands", files: [{ path: "a.ts" }], checks: [], recovered: [], labels }),
		).toBe("3 commands\n\nChanged files (2)\n- a.ts");
	});
});

describe("operationLabel", () => {
	it("names a command as typed, an edit by its project paths and a device write by its device", () => {
		expect(operationLabel({ toolName: "bash", args: { command: "git  push\norigin main" } }, "/p")).toBe(
			"git push origin main",
		);
		expect(operationLabel({ toolName: "edit", args: { path: "/p/src/a.ts" } }, "/p")).toBe("edit src/a.ts");
		expect(operationLabel({ toolName: "write", args: { path: "xd://lsp", content: "{}" } }, "/p")).toBe("xd://lsp");
	});
});
