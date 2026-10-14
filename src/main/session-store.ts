import { z } from "zod";
import type { SessionInfo } from "../shared/ipc-types";
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
	}),
);

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

	stop(): void {
		stopStockHelper();
	}
}
