import { z } from "zod";
import type { SessionInfo } from "../shared/ipc-types";
import type { AgentMessage } from "../shared/rpc-types";
import { configureStockHelper, stockHelperRequest, stopStockHelper } from "./stock-helper";

const sessionRows = z.array(
	z.object({
		path: z.string(),
		id: z.string(),
		title: z
			.string()
			.nullish()
			.transform(value => value ?? null),
		cwd: z.string(),
		created: z.string(),
		modified: z.string(),
		messageCount: z.number(),
		size: z.number(),
		status: z.enum(["complete", "interrupted", "aborted", "error", "pending", "unknown"]).default("unknown"),
		firstMessage: z.string(),
		parentSessionPath: z.string().optional(),
		promptOriginDevice: z.string().optional(),
	}),
);

const movedSession = z.object({ sessionPath: z.string() });
const createdSession = z.object({ sessionPath: z.string(), sessionId: z.string() });

/** Session wire adaptation only. Listing/deletion share the app's stock helper. */
export class StockSessionStore {
	readonly #sessionsRoot: string;

	constructor(sessionsRoot: string, bridgeDir: string) {
		this.#sessionsRoot = sessionsRoot;
		configureStockHelper(bridgeDir);
	}

	async list(): Promise<SessionInfo[]> {
		return sessionRows.parse(await stockHelperRequest("sessions.list", { sessionsRoot: this.#sessionsRoot }));
	}

	async listDirectory(sessionPath: string): Promise<SessionInfo[]> {
		return sessionRows.parse(
			await stockHelperRequest("sessions.list_directory", { sessionsRoot: this.#sessionsRoot, sessionPath }),
		);
	}

	async delete(sessionPath: string): Promise<void> {
		await stockHelperRequest("sessions.delete", { sessionsRoot: this.#sessionsRoot, sessionPath });
	}

	/** Stock `SessionManager.moveTo` in the helper; returns the session's new path. */
	async move(sessionPath: string, cwd: string): Promise<string> {
		const result = movedSession.parse(
			await stockHelperRequest("sessions.move", { sessionsRoot: this.#sessionsRoot, sessionPath, cwd }),
		);
		return result.sessionPath;
	}

	/** A new titled session file in `cwd` (stock `createEmptySessionFile` and `renameSessionTitle` in the helper). */
	async createNamed(cwd: string, title: string): Promise<{ sessionPath: string; sessionId: string }> {
		return createdSession.parse(
			await stockHelperRequest("sessions.createNamed", { sessionsRoot: this.#sessionsRoot, cwd, title }),
		);
	}

	/** A stored session's transcript (stock `loadSessionMessagesReadOnly` in the helper). */
	async messages(sessionPath: string): Promise<AgentMessage[]> {
		const result = await stockHelperRequest("sessions.messages", { sessionsRoot: this.#sessionsRoot, sessionPath });
		return Array.isArray(result) ? (result as AgentMessage[]) : [];
	}

	/** Whether another live omp process owns the session's file (stock's ownership lease); false when unknown. */
	async owned(sessionPath: string): Promise<boolean> {
		const result = await stockHelperRequest("sessions.owned", { sessionsRoot: this.#sessionsRoot, sessionPath });
		return result === true;
	}

	stop(): void {
		stopStockHelper();
	}
}
