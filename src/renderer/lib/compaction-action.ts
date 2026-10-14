/**
 * Locale key naming an automatic maintenance action the way stock's loader and
 * status lines do (pi-coding-agent `modes/controllers/event-controller.ts`):
 * `Auto-handoff`, `Auto-shake`, `Auto-snapcompact`, `Auto server compaction`,
 * otherwise `Auto context-full maintenance`.
 */
export function compactionActionKey(action: string): string {
	switch (action) {
		case "handoff":
			return "chat.compaction.action.handoff";
		case "shake":
			return "chat.compaction.action.shake";
		case "snapcompact":
			return "chat.compaction.action.snapcompact";
		case "remote":
			return "chat.compaction.action.remote";
		default:
			return "chat.compaction.action.default";
	}
}
