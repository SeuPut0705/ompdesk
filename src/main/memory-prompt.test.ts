import { describe, expect, it } from "vitest";
import {
	CHECKOUT_REV_PARSE_ARGS,
	type CheckoutProbe,
	CONCLUSION_MAX_BYTES,
	checkoutParams,
	childMarker,
	conclusionExcerpt,
	firstMeaningfulLine,
	isAgentPrompt,
	isChildSession,
	isJunkTitle,
	nextAgentDriven,
	promptTitle,
	unwrapPrompt,
} from "../../resources/gui-bridge/memory-prompt";
import { assignmentHeadline, assignmentTitle } from "../../resources/gui-bridge/modes/subagent-title-contracts";
import { agentTaskTitle, wrapAgentMessage } from "../shared/agent-control";

const stock = (assignment: string) => `Complete assignment thoroughly:\n\n${assignment}`;

describe("promptTitle", () => {
	it("reads the Title: line of a subagent's assignment, not stock's prefix", () => {
		expect(promptTitle(stock("Title: 시작하기에서 주요 프로바이더를 맨 위에\n\nIn the first-run step…"))).toBe(
			"시작하기에서 주요 프로바이더를 맨 위에",
		);
	});

	it("unwraps the agent-message wrapper and reads the body's Title: line (never the sender's title)", () => {
		const wrapped = wrapAgentMessage("Title: 맥 자동업데이트 확인\n\nCheck the updater.", "병렬 세션 자동 정리");
		expect(promptTitle(wrapped)).toBe("맥 자동업데이트 확인");
	});

	it("unwraps both wrappers whichever way they nest", () => {
		const inner = wrapAgentMessage(stock("Title: 중첩된 작업\n\nbody"), "부모");
		expect(promptTitle(inner)).toBe("중첩된 작업");
		expect(promptTitle(stock(wrapAgentMessage("Title: 반대 순서\n\nbody", "부모")))).toBe("반대 순서");
	});

	it("falls back to the omp session's own title when the prompt has no Title: line", () => {
		expect(
			promptTitle(wrapAgentMessage("Fix the sidebar overflow.", "부모"), { sessionName: "사이드바 넘침 수정" }),
		).toBe("사이드바 넘침 수정");
	});

	it("never takes a session title that is itself junk", () => {
		const wrapped = wrapAgentMessage("Fix the sidebar overflow.", "부모");
		expect(promptTitle(wrapped, { sessionName: '<ompdesk-agent-message from="부모">' })).toBe(
			"Fix the sidebar overflow.",
		);
		expect(promptTitle(wrapped, { sessionName: "Complete assignment thoroughly:" })).toBe(
			"Fix the sidebar overflow.",
		);
	});

	it("falls back to the first meaningful line once known prefixes are stripped", () => {
		expect(promptTitle(stock("Fix the sidebar overflow.\nMore detail."))).toBe("Fix the sidebar overflow.");
		expect(promptTitle("You are a subagent spawned by another session.\n\nAudit the settings page.")).toBe(
			"Audit the settings page.",
		);
		expect(promptTitle("\n\n  ## Plan the release \n\nbody")).toBe("Plan the release");
		expect(promptTitle("<context>\n---\n이제 업데이트 완료했어\n</context>")).toBe("이제 업데이트 완료했어");
	});

	it("names a brief that opens with a one-word section heading by the line under it, never 'Target'", () => {
		expect(
			promptTitle(stock("# Target\nUpdate README.md and docs/DETAILS.md for the new picker.\n\n# Change\n…")),
		).toBe("Update README.md and docs/DETAILS.md for the new picker.");
		expect(promptTitle(stock("## 목표:\n\n사이드바 줄 높이 맞추기"))).toBe("사이드바 줄 높이 맞추기");
		expect(promptTitle(stock("# Fix 1: duplicate name under caption\nbody"))).toBe(
			"Fix 1: duplicate name under caption",
		);
		expect(promptTitle(stock("# Target"))).toBe("Target");
	});

	it("keeps a person's own prompt as it is (first line)", () => {
		expect(promptTitle("그리고 상단바에 눈깔표시는 뭐야?")).toBe("그리고 상단바에 눈깔표시는 뭐야?");
		expect(promptTitle("첫 줄\n둘째 줄")).toBe("첫 줄");
	});

	it("does not treat a long Title: line as a title, but still drops the label", () => {
		const long = `Title: ${"가".repeat(130)}`;
		const title = promptTitle(long);
		expect(title?.startsWith("Title:")).toBe(false);
		expect(title?.length).toBeLessThanOrEqual(120);
		expect(title?.endsWith("…")).toBe(true);
	});

	it("has no title for a prompt with nothing to say", () => {
		expect(promptTitle("")).toBeUndefined();
		expect(promptTitle(wrapAgentMessage("", "부모"))).toBeUndefined();
		expect(promptTitle("Complete assignment thoroughly:")).toBeUndefined();
	});

	it("reads a wrapper cut short (a listing's prefix) like agentTaskTitle does", () => {
		const cut = `<ompdesk-agent-message from="부모">\nTitle: 잘린 메시지\n\nbody that is cut`;
		expect(promptTitle(cut)).toBe(agentTaskTitle(cut));
	});

	it("agrees with the Title: rule the bridge and the sidebar use", () => {
		for (const assignment of [
			"Title: 한 줄 제목\n\nbody",
			"Title:    spaced   \nrest",
			"no label here\nTitle: late",
		]) {
			const expected = assignmentTitle(assignment) ?? assignmentHeadline(assignment);
			expect(promptTitle(stock(assignment))).toBe(expected);
		}
	});
});

describe("unwrapPrompt / firstMeaningfulLine", () => {
	it("reports which wrapper carried the prompt", () => {
		expect(unwrapPrompt(wrapAgentMessage("hi", "부모"))).toEqual({
			body: "hi",
			agentMessage: true,
			subagentAssignment: false,
		});
		expect(unwrapPrompt(stock("hi"))).toEqual({ body: "hi", agentMessage: false, subagentAssignment: true });
		expect(unwrapPrompt("hi")).toEqual({ body: "hi", agentMessage: false, subagentAssignment: false });
	});

	it("an attribute with entities and a CRLF wrapper still unwrap", () => {
		const text = `<ompdesk-agent-message from="a &amp; b">\r\nTitle: x\r\n</ompdesk-agent-message>`;
		expect(unwrapPrompt(text)).toMatchObject({ body: "Title: x", agentMessage: true });
	});

	it("skips tags, rules and fences", () => {
		expect(firstMeaningfulLine("<a>\n***\n```ts\nreal line")).toBe("real line");
	});
});

describe("isJunkTitle", () => {
	it("names the titles the first prompt line used to give", () => {
		expect(isJunkTitle('<ompdesk-agent-message from="휴대폰 테마 설정 분리">')).toBe(true);
		expect(isJunkTitle("Complete assignment thoroughly:")).toBe(true);
		expect(isJunkTitle("You are a subagent spawned by another session.")).toBe(true);
		expect(isJunkTitle("Session 01a14f97-00cf-70df-bcbf-50d074b4b6ca")).toBe(true);
		expect(isJunkTitle("session")).toBe(true);
		expect(isJunkTitle("")).toBe(true);
	});

	it("leaves real titles alone", () => {
		expect(isJunkTitle("이제 업데이트 완료했어 AI 메모리도 승인해놨고")).toBe(false);
		expect(isJunkTitle("Complete the migration")).toBe(false);
	});
});

describe("child sessions", () => {
	it("a subagent is a child, named by its definition and its spawner", () => {
		const agent = { kind: "sub", id: "0-Explore", name: "explore", parentId: "Main" };
		expect(childMarker(agent, false)).toEqual({ subagentType: "explore", agent_id: "Main" });
		expect(isChildSession(agent, false)).toBe(true);
		expect(childMarker({ kind: "sub", id: "0-X" }, false)).toEqual({ subagentType: "sub", agent_id: "0-X" });
	});

	it("a session only agents have written to is a child; the main session is not", () => {
		const main = { kind: "main", id: "Main", name: "main", depth: 0 } as const;
		expect(childMarker(main, true)).toEqual({ subagentType: "agent-opened" });
		expect(isChildSession(main, true)).toBe(true);
		expect(childMarker(main, false)).toEqual({});
		expect(isChildSession(undefined, false)).toBe(false);
	});

	it("a person's prompt makes the session theirs, for good", () => {
		const wrapped = wrapAgentMessage("Title: a\n\nb", "부모");
		let driven = nextAgentDriven(undefined, wrapped);
		expect(driven).toBe(true);
		driven = nextAgentDriven(driven, wrapAgentMessage("more", "부모"));
		expect(driven).toBe(true);
		driven = nextAgentDriven(driven, "고쳐줘");
		expect(driven).toBe(false);
		expect(nextAgentDriven(driven, wrapped)).toBe(false);
	});

	it("a first prompt typed by a person is main from the start", () => {
		expect(nextAgentDriven(undefined, "안녕")).toBe(false);
		expect(isAgentPrompt(stock("Title: x"))).toBe(true);
	});
});

describe("conclusionExcerpt", () => {
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	const assistant = (...content: unknown[]) => ({ role: "assistant", content });
	const text = (value: string) => ({ type: "text", text: value });

	it("keeps only the text parts of the last assistant message", () => {
		const messages = [
			user("어떻게 됐어?"),
			assistant(text("first answer")),
			{ role: "toolResult", content: [text("tool output")] },
			assistant(
				{ type: "thinking", thinking: "private reasoning" },
				text("Jev가 확실히 나아요."),
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				text("92.4% vs 74.2%"),
			),
		];
		expect(conclusionExcerpt(messages)).toBe("Jev가 확실히 나아요.\n\n92.4% vs 74.2%");
	});

	it("is undefined without an assistant message or when its text is blank", () => {
		expect(conclusionExcerpt([])).toBeUndefined();
		expect(conclusionExcerpt([user("hi")])).toBeUndefined();
		expect(conclusionExcerpt([assistant({ type: "toolCall", id: "c", name: "x", arguments: {} })])).toBeUndefined();
		expect(conclusionExcerpt([assistant(text("  \n "))])).toBeUndefined();
	});

	it("redacts secrets and the home folder before storing", () => {
		const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
		const excerpt = conclusionExcerpt([assistant(text(`Pushed with ${token} from /Users/jane/project.`))]);
		expect(excerpt).not.toContain(token);
		expect(excerpt).not.toContain("/Users/jane");
		expect(excerpt).toContain("~/project");
	});

	it("is at most 2000 UTF-8 bytes, cut on a character boundary", () => {
		const excerpt = conclusionExcerpt([assistant(text("결론".repeat(800)))]) ?? "";
		expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(CONCLUSION_MAX_BYTES);
		expect(CONCLUSION_MAX_BYTES).toBe(2000);
		expect(excerpt).not.toContain("\uFFFD");
		expect(excerpt.startsWith("결론결론")).toBe(true);
		expect(new TextEncoder().encode(excerpt).length).toBeGreaterThan(1990);
	});
});

describe("checkoutParams", () => {
	/** A machine where `links` maps a path to where it really is and git answers `git` for a folder. */
	const machine = (git: Record<string, string | null>, links: Record<string, string> = {}): CheckoutProbe => ({
		revParse: cwd => (cwd in git ? git[cwd] : undefined),
		realpath: path => {
			for (const [link, target] of Object.entries(links)) {
				if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length);
			}
			return path;
		},
	});

	it("asks git for the work tree and the shared git dir, as absolute paths", () => {
		expect(CHECKOUT_REV_PARSE_ARGS).toEqual([
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
		]);
	});

	it("spells the checkout root the way the cwd spells it, as the server's canonicalize did", () => {
		const cwd = "/var/u/Desktop/app/src";
		const probe = machine(
			{ [cwd]: "/private/var/u/Desktop/app\n/private/var/u/Desktop/app/.git\n" },
			{ "/var": "/private/var" },
		);
		expect(checkoutParams(cwd, probe)).toEqual({
			repo_root: "/var/u/Desktop/app",
			main_repo_root: "/var/u/Desktop/app",
		});
	});

	it("names a linked worktree's main checkout where git puts it", () => {
		const cwd = "/w/feature";
		expect(checkoutParams(cwd, machine({ [cwd]: "/w/feature\n/m/acme/.git\n" }))).toEqual({
			repo_root: "/w/feature",
			main_repo_root: "/m/acme",
		});
	});

	it("says there is no checkout when git ran and found none", () => {
		expect(checkoutParams("/u/Desktop/notes", machine({ "/u/Desktop/notes": null }))).toEqual({ repo_root: "" });
	});

	it("sends nothing when git could not run or answered something else, so the server looks itself", () => {
		expect(checkoutParams("/u/api", machine({}))).toBeUndefined();
		expect(checkoutParams("/u/api", machine({ "/u/api": "/u/api\n" }))).toBeUndefined();
	});
});
