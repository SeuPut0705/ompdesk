import { describe, expect, it } from "vitest";
import { buildIssueBody, buildIssueUrl, formatErrorTail } from "./feedback";

const env = { appVersion: "0.9.13", platform: "darwin", arch: "arm64", electron: "36.9.5", chrome: "134.0" };

describe("buildIssueUrl", () => {
	it("targets the GUI repo's issue form with kind-derived title and labels", () => {
		const url = new URL(buildIssueUrl({ kind: "bug", title: "Sync fails", description: "Pressed sync, got a 405." }));
		expect(`${url.origin}${url.pathname}`).toBe("https://github.com/SeuPut0705/ompdesk/issues/new");
		expect(url.searchParams.get("title")).toBe("[Bug] Sync fails");
		expect(url.searchParams.get("labels")).toBe("gui,bug");
		expect(url.searchParams.get("body")).toContain("Pressed sync, got a 405.");
	});

	it("maps feature and question kinds to their labels and prefixes", () => {
		for (const [kind, prefix, label] of [
			["feature", "[Feature] ", "enhancement"],
			["question", "[Question] ", "question"],
		] as const) {
			const url = new URL(buildIssueUrl({ kind, title: "x", description: "d" }));
			expect(url.searchParams.get("title")).toBe(`${prefix}x`);
			expect(url.searchParams.get("labels")).toBe(`gui,${label}`);
		}
	});

	it("attaches environment and error tail only when provided", () => {
		const bare = buildIssueBody({ kind: "bug", title: "t", description: "d" });
		expect(bare).not.toContain("Environment");
		expect(bare).not.toContain("Error details");
		const full = buildIssueBody({
			kind: "bug",
			title: "t",
			description: "d",
			environment: env,
			errors: ['{"report":{"source":"renderer-console","message":"boom"}}'],
			prefillError: "TypeError: exploded",
		});
		expect(full).toContain("v0.9.13");
		expect(full).toContain("darwin arm64");
		expect(full).toContain("TypeError: exploded");
		expect(full).toContain("boom");
		expect(full).toContain("<details>");
	});

	it("keeps long reports under the URL length cap instead of dropping them", () => {
		const url = buildIssueUrl({
			kind: "bug",
			title: "t",
			description: "아주 긴 설명이에요.".repeat(3000),
			environment: env,
			errors: ['{"report":{"source":"x","message":"e"}}'],
		});
		expect(url.length).toBeLessThanOrEqual(8000);
		expect(new URL(url).searchParams.get("body")).toContain("아주 긴 설명이에요");
	});
});

describe("formatErrorTail", () => {
	it("summarizes log lines as source + message with a trimmed stack", () => {
		const stack = Array.from({ length: 40 }, (_, i) => `    at frame${i}`).join("\n");
		const out = formatErrorTail([
			JSON.stringify({ ts: "t", report: { source: "react-render", message: "crash", stack } }),
		]);
		expect(out).toContain("`react-render` crash");
		expect(out).toContain("at frame5");
		expect(out).not.toContain("at frame6");
	});

	it("skips blank/unusable lines and keeps the newest ones within the budget", () => {
		const lines = ["", "not json", '{"report":{"message":"old"}}', '{"report":{"message":"new"}}'];
		expect(formatErrorTail(lines)).toBe("`unknown` old\n`unknown` new");
		const huge = JSON.stringify({ report: { source: "x", message: "m".repeat(4000) } });
		expect(formatErrorTail([huge, huge, huge])).toHaveLength(0); // over the tail budget → dropped
		// Over the budget the oldest go, never the newest: the error being reported is the last one logged.
		const error = (message: string) => JSON.stringify({ report: { source: "x", message: message.padEnd(900, ".") } });
		const tail = formatErrorTail([error("first"), error("second"), error("third"), error("fourth")]);
		expect(tail).not.toContain("first");
		expect(tail.split("\n").map(line => line.slice(0, 10))).toEqual(["`x` second", "`x` third.", "`x` fourth"]);
	});
});
