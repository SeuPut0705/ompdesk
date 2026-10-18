import { useLang, useT } from "../../../lib/i18n";

/**
 * Strings that only the prototypes need (new labels the production locale has no key for). Everything that exists
 * in src/renderer/locales comes from the real `t()`; these are listed in local://composer-proto-phone.md as the keys
 * the winner would add to en.ts and ko.ts.
 */
const PROTO: Record<"en" | "ko", Record<string, string>> = {
	en: {
		"pp.runControls": "Run controls",
		"pp.runStatus": "Run status",
		"pp.model": "Model",
		"pp.normal": "Normal",
		"pp.newline": "New line",
		"pp.newlineHint": "Hold Send for a new line",
		"pp.moreRows": "+{count} more",
		"pp.messageActions": "Message actions",
		"pp.queueEdit": "Edit queued message",
		"pp.more": "More",
		"pp.thumbsMore": "{count} more pictures",
		"pp.tilesTitle": "Add",
		"pp.runTitle": "Run settings",
		"pp.plan": "Plan",
		"pp.goal": "Goal",
		"pp.autopilot": "Autopilot",
		"pp.sessionTitle": "Fix the flaky login test",
		"pp.sessions": "Sessions",
		"pp.sessionActions": "Session actions",
		"pp.workPlan": "Update the e2e fixtures",
		"pp.userMsg1": "The login spec fails about one run in five. Can you find out why?",
		"pp.asst1":
			"It waits for the redirect with a fixed timeout, so a slow CI run loses the race. I will wait for the URL instead.",
		"pp.userMsg2": "Do that, and keep the change small.",
		"pp.asst2": "Working on it: replacing the sleep in auth.spec.ts with an explicit wait for the dashboard route.",
		"pp.draftSample": "Fix the flaky login test in auth.spec.ts",
		"pp.draftMulti":
			"Plan for the fix:\n1. wait for the dashboard URL\n2. drop the 2 s sleep\n3. rerun the spec ten times",
		"pp.draftRunning": "also skip the snapshot tests",
		"pp.suggest1": "Run the tests again",
		"pp.suggest2": "Summarize the diff",
		"pp.q1": "Also update the changelog",
		"pp.q2": "Then run the full e2e suite and report every failure",
		"pp.q3": "Open a pull request when it is green",
		"pp.longDraftTitle": "Long draft",
		"pp.collapse": "Collapse",
		"pp.swipeHint": "Tap a message to edit it",
		"pp.contextUsed": "{percent} % used",
		"pp.keyboard": "keyboard",
		"pp.cmd.review": "Review the current changes",
		"pp.cmd.compact": "Compact the conversation",
		"pp.cmd.model": "Switch model",
		"pp.cmd.plan": "Toggle plan mode",
		"pp.cmd.tree": "Browse the session tree",
		"pp.cmd.share": "Share this session",
		"pp.cmd.export": "Export as HTML",
		"pp.cmd.fork": "Fork from a message",
		"pp.cmd.todo": "Show the todo list",
		"pp.cmd.memory": "Search memory",
		"pp.cmd.mcp": "Manage MCP servers",
		"pp.cmd.skill": "Use a skill",
	},
	ko: {
		"pp.runControls": "실행 제어",
		"pp.runStatus": "실행 상태",
		"pp.model": "모델",
		"pp.normal": "일반",
		"pp.newline": "줄바꿈",
		"pp.newlineHint": "보내기를 길게 눌러 줄바꿈",
		"pp.moreRows": "{count}개 더",
		"pp.messageActions": "메시지 동작",
		"pp.queueEdit": "대기 메시지 편집",
		"pp.more": "더 보기",
		"pp.thumbsMore": "사진 {count}장 더",
		"pp.tilesTitle": "추가",
		"pp.runTitle": "실행 설정",
		"pp.plan": "계획",
		"pp.goal": "목표",
		"pp.autopilot": "오토파일럿",
		"pp.sessionTitle": "불안정한 로그인 테스트 고치기",
		"pp.sessions": "세션",
		"pp.sessionActions": "세션 동작",
		"pp.workPlan": "e2e 픽스처 업데이트",
		"pp.userMsg1": "로그인 스펙이 다섯 번에 한 번꼴로 실패해요. 원인을 찾아줄래요?",
		"pp.asst1": "리디렉션을 고정 타임아웃으로 기다려서 느린 CI에서는 경쟁에서 져요. URL을 기다리도록 바꿀게요.",
		"pp.userMsg2": "그렇게 하되 변경은 작게 유지해줘요.",
		"pp.asst2": "진행 중: auth.spec.ts의 sleep을 대시보드 경로를 명시적으로 기다리는 코드로 바꾸고 있어요.",
		"pp.draftSample": "auth.spec.ts의 불안정한 로그인 테스트를 고쳐줘",
		"pp.draftMulti": "수정 계획:\n1. 대시보드 URL 기다리기\n2. 2초 sleep 제거\n3. 스펙을 열 번 다시 실행",
		"pp.draftRunning": "스냅샷 테스트는 건너뛰어줘",
		"pp.suggest1": "테스트 다시 실행",
		"pp.suggest2": "변경 사항 요약",
		"pp.q1": "변경 이력도 업데이트해줘",
		"pp.q2": "그다음 전체 e2e 스위트를 돌리고 실패를 모두 알려줘",
		"pp.q3": "통과하면 풀 리퀘스트를 열어줘",
		"pp.longDraftTitle": "긴 초안",
		"pp.collapse": "접기",
		"pp.swipeHint": "메시지를 눌러 편집하세요",
		"pp.contextUsed": "{percent} % 사용",
		"pp.keyboard": "키보드",
		"pp.cmd.review": "현재 변경 사항 검토",
		"pp.cmd.compact": "대화 압축",
		"pp.cmd.model": "모델 전환",
		"pp.cmd.plan": "계획 모드 전환",
		"pp.cmd.tree": "세션 트리 보기",
		"pp.cmd.share": "이 세션 공유",
		"pp.cmd.export": "HTML로 내보내기",
		"pp.cmd.fork": "메시지에서 분기",
		"pp.cmd.todo": "할 일 목록 보기",
		"pp.cmd.memory": "메모리 검색",
		"pp.cmd.mcp": "MCP 서버 관리",
		"pp.cmd.skill": "스킬 사용",
	},
};

/** A prototype-only string in the page language (falls back to English, then the key). */
export function useP(): (key: string, params?: Record<string, string | number>) => string {
	const { lang } = useLang();
	return (key, params) => {
		let text = PROTO[lang === "ko" ? "ko" : "en"][key] ?? PROTO.en[key] ?? key;
		if (params) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
		return text;
	};
}

export { useT };
