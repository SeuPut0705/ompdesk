import { describe, expect, it } from "vitest";
import { notificationWebUrl } from "../../../shared/github";
import { parseGithubRequest } from "./github";

describe("github requests", () => {
	it("accepts each operation's shape with an optional host and OWNER/NAME repository", () => {
		expect(
			parseGithubRequest({ op: "issue_list", state: "open", repo: "octo-org/app.js", host: "ghe.example.com" }),
		).toEqual({
			op: "issue_list",
			state: "open",
			repo: "octo-org/app.js",
			host: "ghe.example.com",
		});
		expect(parseGithubRequest({ op: "repo_clone", repo: "o/r", destination: "/tmp/r" })).toMatchObject({
			destination: "/tmp/r",
		});
		expect(
			parseGithubRequest({
				op: "release_create",
				tag: "v1.0.0",
				title: "One",
				notes: "",
				draft: true,
				prerelease: false,
			}),
		).toMatchObject({ draft: true });
		expect(parseGithubRequest({ op: "workflow_dispatch", workflow: "ci.yml" })).toEqual({
			op: "workflow_dispatch",
			workflow: "ci.yml",
		});
	});

	it("refuses anything gh could read as a flag, a host part in repo, and a clone without an absolute path", () => {
		for (const bad of [
			{ op: "release_get", tag: "--help" },
			{ op: "workflow_dispatch", workflow: "ci.yml", ref: "-x" },
			{ op: "workflow_dispatch", workflow: "ci.yml", ref: "a b" },
			{ op: "issue_list", state: "open", repo: "github.com/o/r" },
			{ op: "issue_list", state: "open", host: "evil.com/x" },
			{ op: "repo_clone", repo: "o/r", destination: "relative/dir" },
			{ op: "repo_create", name: "a b", visibility: "public", description: "" },
			{ op: "repo_create", name: "ok", description: "" },
			{ op: "notification_read", id: "../user" },
			{ op: "issue_get", number: 0 },
			{ op: "issue_create", title: "  ", body: "" },
			{ op: "unknown" },
		]) {
			expect(() => parseGithubRequest(bad), JSON.stringify(bad)).toThrow(/Invalid GitHub request/);
		}
	});

	it("turns a notification subject's API URL into its web page", () => {
		expect(notificationWebUrl("https://api.github.com/repos/o/r/pulls/7")).toBe("https://github.com/o/r/pull/7");
		expect(notificationWebUrl("https://api.github.com/repos/o/r/issues/3")).toBe("https://github.com/o/r/issues/3");
		expect(notificationWebUrl("https://api.github.com/repos/o/r/commits/abc")).toBe(
			"https://github.com/o/r/commit/abc",
		);
		expect(notificationWebUrl("https://api.github.com/repos/o/r/releases/123")).toBe(
			"https://github.com/o/r/releases",
		);
		expect(notificationWebUrl("https://ghe.example.com/api/v3/repos/o/r/issues/1")).toBe(
			"https://ghe.example.com/o/r/issues/1",
		);
		expect(notificationWebUrl(null)).toBeNull();
		expect(notificationWebUrl("https://example.com/x")).toBeNull();
	});
});
