// Defer stock imports until guard succeeds: incompatible omp modules must not prevent bridge startup.
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = guard("inputHistory", {
	history_recent: async params => {
		const { HistoryStorage } = await import("@oh-my-pi/pi-coding-agent/session/history-storage");
		const input = params as { limit?: number; cwd?: string };
		return HistoryStorage.open().getRecent(input.limit ?? 200, { cwd: input.cwd });
	},
	history_search: async params => {
		const { HistoryStorage } = await import("@oh-my-pi/pi-coding-agent/session/history-storage");
		const input = params as { query: string; limit?: number; cwd?: string };
		return HistoryStorage.open().search(input.query, input.limit ?? 100, { cwd: input.cwd });
	},
	history_record: async (params, env) => {
		const { HistoryStorage } = await import("@oh-my-pi/pi-coding-agent/session/history-storage");
		const input = params as { prompt: string; cwd?: string };
		const { shouldSkipHistory } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/input-controller");
		const skipped = shouldSkipHistory(input.prompt);
		if (!skipped) await HistoryStorage.open().add(input.prompt, input.cwd, env.session().sessionManager.getSessionId());
		return { skipped };
	},
});
