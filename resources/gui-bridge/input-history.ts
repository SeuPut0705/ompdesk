// Defer stock imports until guard succeeds: incompatible omp modules must not prevent bridge startup.
// Reads (recent, search) are not here: they are answered by the stock helper (stock-helper/history.ts), never
// through the tab's omp, whose thread a turn keeps busy. The write stays here for the session id.
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = guard("inputHistory", {
	history_record: async (params, env) => {
		const { HistoryStorage } = await import("@oh-my-pi/pi-coding-agent/session/history-storage");
		const input = params as { prompt: string; cwd?: string };
		const { shouldSkipHistory } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/input-controller");
		const skipped = shouldSkipHistory(input.prompt);
		if (!skipped)
			await HistoryStorage.open().add(input.prompt, input.cwd, env.session().sessionManager.getSessionId());
		return { skipped };
	},
});
