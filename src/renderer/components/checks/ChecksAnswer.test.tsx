import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "../../../shared/checks-contract";
import { sampleAnswer } from "../../../shared/checks-fixture";
import type { ChecksFrame } from "../../../shared/checks-frame";
import { checksFrame } from "../../dev-harness/fixture-checks";
import { I18nProvider, loadLocale, setLanguageOverride } from "../../lib/i18n";
import { useChecksStore } from "../../stores/checks";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// react-dom reads the DOM globals when it loads, so it is imported after they exist (the linkedom harness).
const { createRoot } = await import("react-dom/client");
const { ChecksPage } = await import("./ChecksPage");

const FIXED_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
/** What the core's English fields hold: neither language's screen may show them. */
const RAW_NOTE = "RAW-ENGLISH-NOTE";
const RAW_HISTORY = "RAW-ENGLISH-HISTORY";

let root: Root | undefined;

/** An answer carrying one note of every kind a judged red run writes, and a failed test with its record. */
function judgedAnswer(): Answer {
	const answer = {
		...sampleAnswer("run-41"),
		failed: [
			{
				test: "src/store/save.test.ts > saves the file once",
				firstError: "AssertionError: expected 1 to be 2",
				knownFlaky: true,
				history: RAW_HISTORY,
				record: {
					os: "linux",
					fails7d: 3,
					runs7d: 20,
					state: "quarantined",
					cleanRuns: 2,
					clearAfter: 5,
				},
			},
		],
		notes: [RAW_NOTE],
		said: [
			{ code: "report-expired", job: "7" },
			{ code: "quarantine-entered", test: "src/a.test.ts > adds" },
			{ code: "quarantined-pass", count: 1 },
			{ code: "job-outside-tests", job: "check" },
			{ code: "reruns-used", used: 0, cap: 2 },
			{ code: "facts-stale", at: FIXED_NOW - 600_000, error: "gh is offline" },
		],
	};
	return answer as unknown as Answer;
}

async function mount(): Promise<string> {
	const base: ChecksFrame = checksFrame("busy", FIXED_NOW, false);
	const [first] = base.snapshot.answers;
	const frame: ChecksFrame = {
		...base,
		snapshot: { ...base.snapshot, answers: first ? [{ ...first, answer: judgedAnswer() }] : [] },
	};
	useChecksStore.getState().apply(frame);
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ChecksPage />
			</I18nProvider>,
		),
	);
	return (container as unknown as Element).querySelector("[data-check-answer]")?.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	useChecksStore.getState().reset();
	setLanguageOverride(null);
});

describe("The answer card", () => {
	it("shows a note and a failed test's record as the page's own words in Korean, never the core's English", async () => {
		await loadLocale("ko");
		setLanguageOverride("ko");
		const card = await mount();
		expect(card).toContain("작업 7의 테스트 리포트가 만료됐어요");
		expect(card).toContain("격리 시작: src/a.test.ts > adds");
		expect(card).toContain("격리된 불안정 테스트 1개가 실패했지만 이 실행은 실패로 치지 않아요");
		expect(card).toContain("작업 “check”이 테스트 밖에서 실패했거나 테스트 리포트가 없어요");
		expect(card).toContain("실패한 작업 다시 실행: 2번 중 0번 썼어요");
		expect(card).toContain("GitHub 정보가 오래됐어요");
		expect(card).toContain("gh is offline");
		expect(card).toContain("Linux에서 최근 7일간 20번 중 3번 실패");
		expect(card).toContain("불안정해서 격리 중 (같은 입력에서 통과와 실패가 모두 나왔어요), 깨끗한 실행 2/5");
		expect(card).not.toContain(RAW_NOTE);
		expect(card).not.toContain(RAW_HISTORY);
		expect(card).not.toMatch(/checks\.[a-z]/);
	});

	it("shows them in English from the same codes", async () => {
		const card = await mount();
		expect(card).toContain("The test report of job 7 expired");
		expect(card).toContain("src/a.test.ts > adds is now in quarantine");
		expect(card).toContain("1 quarantined flaky test failed; they do not fail this run");
		expect(card).toContain("Reruns of the failed jobs: 0 of 2 used");
		expect(card).toContain("on Linux: failed 3 of 20 runs in 7 days");
		expect(card).toContain("2 of 5 clean runs");
		expect(card).not.toContain(RAW_NOTE);
		expect(card).not.toContain(RAW_HISTORY);
	});
});
