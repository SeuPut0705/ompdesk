/** Memory › Handoffs. `en` and `ko` carry exactly the same keys (locales.test.ts). */
export const en: Record<string, string> = {
	"memory.handoffs.title": "Handoffs",
	"memory.handoffs.info":
		"The note the next session in a folder starts from. Reading one here doesn't use it up: the next session still gets it. Cancel discards it.",
	"memory.handoffs.empty": "No handoffs.",
	"memory.handoffs.pick": "Pick a handoff.",
	"memory.handoffs.state.open": "Open",
	"memory.handoffs.state.accepted": "Used",
	"memory.handoffs.state.expired": "Expired",
	"memory.handoffs.from": "From {agent}",
	"memory.handoffs.summary": "Summary",
	"memory.handoffs.questions": "Open questions",
	"memory.handoffs.steps": "Next steps",
	"memory.handoffs.cancel": "Cancel handoff",
	"memory.handoffs.cancel.title": "Cancel this handoff?",
	"memory.handoffs.cancel.message": "The next session no longer starts from {agent}'s note.",
	"memory.handoffs.cancelled": "Handoff cancelled",
};
export const ko: Record<string, string> = {
	"memory.handoffs.title": "인계",
	"memory.handoffs.info":
		"같은 폴더의 다음 세션이 이어서 시작하는 메모예요. 여기서 읽어도 소모되지 않고, 다음 세션이 그대로 받아요. 취소하면 버려져요.",
	"memory.handoffs.empty": "인계가 없어요.",
	"memory.handoffs.pick": "인계를 골라 보세요.",
	"memory.handoffs.state.open": "열림",
	"memory.handoffs.state.accepted": "사용됨",
	"memory.handoffs.state.expired": "만료됨",
	"memory.handoffs.from": "{agent}에서",
	"memory.handoffs.summary": "요약",
	"memory.handoffs.questions": "남은 질문",
	"memory.handoffs.steps": "다음 단계",
	"memory.handoffs.cancel": "인계 취소",
	"memory.handoffs.cancel.title": "이 인계를 취소할까요?",
	"memory.handoffs.cancel.message": "다음 세션은 {agent}의 메모로 시작하지 않아요.",
	"memory.handoffs.cancelled": "인계를 취소했어요",
};
