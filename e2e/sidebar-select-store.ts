/**
 * The fake omp's session index with the one rule of stock's the fixture lacks: a session whose last message is an
 * assistant reply that ended in an error lists as `error` (sidebar-select.e2e.ts installs this as a profile's
 * `session-store.ts`).
 */
import { readFile } from "node:fs/promises";
import { listAllSessions as listAll, listSessionsReadOnly as listOne } from "./session-store-fixture";

export * from "./session-store-fixture";

interface Row {
	path: string;
	status: string;
}

async function endedInError(file: string): Promise<boolean> {
	const entries = (await readFile(file, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } });
	const last = entries.filter(entry => entry.type === "message").at(-1)?.message;
	return last?.role === "assistant" && last.stopReason === "error";
}

async function withErrors(rows: unknown[]): Promise<unknown[]> {
	return Promise.all(
		(rows as Row[]).map(async row => ((await endedInError(row.path)) ? { ...row, status: "error" } : row)),
	);
}

export async function listAllSessions(storage: Parameters<typeof listAll>[0], root: string): Promise<unknown[]> {
	return withErrors(await listAll(storage, root));
}

export async function listSessionsReadOnly(dir: string): Promise<unknown[]> {
	return withErrors(await listOne(dir));
}
