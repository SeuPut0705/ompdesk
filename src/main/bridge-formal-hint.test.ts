/**
 * gui-bridge formal-verification hint (modes/formal-hint-core.ts): a turn whose request is a race, duplicate, retry,
 * ordering or never-happens problem gets one section naming `ompdesk-formal-verify`; every other turn gets nothing,
 * and the match is made again on every turn (a subagent's assignment included).
 */
import { describe, expect, it } from "vitest";
import {
	FORMAL_HINT,
	FORMAL_SKILL,
	type FormalHost,
	install,
	isFormalRequest,
} from "../../resources/gui-bridge/modes/formal-hint-core";
import type { PromptSectionContext } from "../../resources/gui-bridge/prompt-sections";

const POSITIVE = [
	"Turn resume sometimes runs the interrupted prompt twice after a restart; find the race and fix it.",
	"There is a race condition between the quit handler and the turn-resume timer.",
	"Remote session listing shows stale state after the link drops and comes back; it is racy.",
	"A coupon was credited twice when the user double-clicked, make the credit idempotent.",
	"The webhook handler is retried twice by the provider and we send two emails. Fix the duplicate send.",
	"Can you prove that the lease can never be held by two sessions at once?",
	"Two workers sometimes deadlock when both take the checkout lock.",
	"Events arrive out of order and the state machine ends in the wrong state.",
	"턴 재개에서 경쟁 조건이 있는 것 같아. 고쳐줘.",
	"쿠폰이 두 번 지급돼. 중복 지급을 막아줘.",
	"원격 세션 목록이 가끔 오래된 상태로 남아. 동시성 문제인지 봐줘.",
	"이 락이 절대 두 곳에서 잡히지 않는다는 걸 증명해줘.",
	"종료 중에 재시도가 순서가 뒤바뀌어서 데드락이 나.",
];

const NEGATIVE = [
	"Rename the variable `tmp` to `elapsedMs` in sidebar.ts.",
	"Add a 200 ms wait before the toast closes.",
	"Make the settings header 4px taller and use the muted color.",
	"Update the README with the new install steps.",
	"Extract the duplicate code in these two helpers into one function.",
	"Sort the file list by name.",
	"Add a Retry button to the error card.",
	"사이드바 간격을 8px로 줄여줘.",
	"README에 설치 방법을 추가해줘.",
	"버튼 색을 파란색으로 바꿔줘.",
	"",
];

describe("isFormalRequest", () => {
	it.each(POSITIVE)("matches: %s", text => {
		expect(isFormalRequest(text)).toBe(true);
	});
	it.each(NEGATIVE)("ignores: %s", text => {
		expect(isFormalRequest(text)).toBe(false);
	});
	it("ignores undefined", () => {
		expect(isFormalRequest(undefined)).toBe(false);
	});
	it("matches a subagent assignment that carries the ask", () => {
		expect(
			isFormalRequest(
				"Title: 경쟁 조건 수정\n\n# Target\nsrc/main/turn-resume.ts\n# Change\nFix the double-run race.",
			),
		).toBe(true);
	});
});

describe("install", () => {
	let hook: Parameters<FormalHost["on"]>[1] | undefined;
	const host: FormalHost = {
		on: (_event, handler) => {
			hook = handler;
		},
	};
	install(host);
	const ctx = (kind: string): PromptSectionContext => ({ agent: { kind }, sessionManager: { getBranch: () => [] } });
	const turn = (prompt: string | undefined, kind = "main") =>
		hook?.({ systemPrompt: ["base"], prompt }, ctx(kind))?.systemPrompt;

	it("names the skill once for a matching turn and nothing for a plain one, turn after turn", () => {
		expect(turn("Rename this variable.")).toBeUndefined();
		const hinted = turn("The job runs twice after restart, find the race.");
		expect(hinted).toEqual(["base", FORMAL_HINT]);
		expect(hinted?.join("\n").split(FORMAL_SKILL)).toHaveLength(2);
		expect(turn("Add a tooltip to the button.")).toBeUndefined();
		expect(turn("두 번 실행되는 경쟁 조건 고쳐줘")).toEqual(["base", FORMAL_HINT]);
		expect(turn("Update the docs.")).toBeUndefined();
	});

	it("does not stack when the prompt already carries it, and reaches subagents", () => {
		expect(
			hook?.({ systemPrompt: ["base", FORMAL_HINT], prompt: "fix the race condition" }, ctx("main")),
		).toBeUndefined();
		expect(turn("# Change\nFix the double-run race.", "sub")).toEqual(["base", FORMAL_HINT]);
	});

	it("adds nothing without a prompt (the inspector, a restored turn)", () => {
		expect(turn(undefined)).toBeUndefined();
	});
});
