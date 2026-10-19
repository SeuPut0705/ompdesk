/** Memory › Sessions. `en` and `ko` carry exactly the same keys (locales.test.ts). */
export const en: Record<string, string> = {
	"memory.sessions.title": "Recent sessions",
	"memory.sessions.info":
		"Sessions Memory recorded, newest first, with how many events each captured. Open one to read its raw events (prompts, tool calls, stops), already scrubbed. Read-only.",
	"memory.sessions.empty": "No sessions recorded yet.",
	"memory.sessions.pick": "Pick a session.",
	"memory.sessions.open": "Open",
	"memory.sessions.job.pending": "Pending",
	"memory.sessions.job.running": "Writing page",
	"memory.sessions.job.failed": "Page failed",
	"memory.sessions.copyId": "Copy session id",
	"memory.sessions.total": "{count} observations",
	"memory.sessions.previous": "Previous",
	"memory.sessions.next": "Next",
	"memory.sessions.more": "Show more",
	"memory.sessions.less": "Show less",
};
export const ko: Record<string, string> = {
	"memory.sessions.title": "최근 세션",
	"memory.sessions.info":
		"메모리가 기록한 세션이에요. 최근 순이고, 세션마다 담은 이벤트 수가 보여요. 열면 프롬프트, 도구 호출, 중단 같은 원본 이벤트를 읽을 수 있고, 민감 정보는 이미 지워져 있어요. 읽기 전용이에요.",
	"memory.sessions.empty": "아직 기록된 세션이 없어요.",
	"memory.sessions.pick": "세션을 골라 보세요.",
	"memory.sessions.open": "진행 중",
	"memory.sessions.job.pending": "대기",
	"memory.sessions.job.running": "페이지 작성 중",
	"memory.sessions.job.failed": "페이지 실패",
	"memory.sessions.copyId": "세션 ID 복사",
	"memory.sessions.total": "관찰 {count}개",
	"memory.sessions.previous": "이전",
	"memory.sessions.next": "다음",
	"memory.sessions.more": "더 보기",
	"memory.sessions.less": "접기",
};
