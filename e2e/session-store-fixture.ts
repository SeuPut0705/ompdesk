/** Filesystem-backed fake stock exports for the fake omp install, not app logic. */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Stock session-listing reads a session's first prompt from this prefix only. */
const LIST_PREFIX_BYTES = 4096;

/** pi-tui `textContent`: text blocks joined by `separator`. */
export function textContent(content: unknown, separator = ""): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(part => part?.type === "text")
		.map(part => part.text ?? "")
		.join(separator);
}

/** session-loader `visitEntriesFromFileStream`: visit records in order until `visit` returns false. */
export async function visitEntriesFromFileStream(
	file: string,
	visit: (entry: unknown) => boolean | undefined,
	options: { maxBytes?: number } = {},
): Promise<undefined> {
	const text = (await readFile(file)).subarray(0, options.maxBytes ?? Number.POSITIVE_INFINITY).toString("utf8");
	for (const line of text.split("\n")) {
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (visit(entry) === false) break;
	}
	return undefined;
}

export class FileSessionStorage {
	async deleteSessionWithArtifacts(file: string): Promise<void> {
		await rm(file, { force: true });
		await rm(file.slice(0, -6), { recursive: true, force: true });
	}
}

export async function listSessionsReadOnly(dir: string): Promise<unknown[]> {
	const names = await readdir(dir).catch(() => []);
	const rows = await Promise.all(
		names
			.filter(name => name.endsWith(".jsonl"))
			.map(async name => {
				const file = join(dir, name);
				const raw = await readFile(file, "utf8");
				const lines = raw.split("\n");
				const entries = lines.filter(Boolean).map(line => JSON.parse(line));
				const header = entries.find(entry => entry.type === "session");
				if (!header) return null;
				const messages = entries.filter(entry => entry.type === "message");
				const title = [...entries].reverse().find(entry => entry.type === "title")?.title;
				const stamp = await stat(file);
				// Like stock, only a first prompt that starts inside the listing prefix is
				// listed; one past it reads stock's "(no messages)" placeholder. (A file with
				// no user message keeps "" here, unlike stock.)
				let offset = 0;
				let firstMessage = "";
				for (const line of lines) {
					const entry = line ? JSON.parse(line) : null;
					if (entry?.type === "message" && entry.message.role === "user") {
						firstMessage = offset < LIST_PREFIX_BYTES ? textContent(entry.message.content, " ") : "(no messages)";
						break;
					}
					offset += Buffer.byteLength(line) + 1;
				}
				return {
					path: file,
					id: header.id,
					cwd: header.cwd,
					title,
					created: header.timestamp,
					modified: stamp.mtime.toISOString(),
					messageCount: messages.length,
					size: stamp.size,
					firstMessage,
					// Stock: a session with no message at all (the bot's, made with a title only) is `unknown`, never `pending`.
					status:
						messages.length === 0
							? "unknown"
							: messages.at(-1)?.message.role === "assistant"
								? "complete"
								: "pending",
					// Stock session-listing: `parentSessionPath: header.parentSession` (set on a fork).
					...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
				};
			}),
	);
	return rows.filter(Boolean);
}

export async function listAllSessions(_storage: FileSessionStorage, root: string): Promise<unknown[]> {
	const names = await readdir(root, { withFileTypes: true }).catch(() => []);
	return (
		await Promise.all(
			names.filter(name => name.isDirectory()).map(name => listSessionsReadOnly(join(root, name.name))),
		)
	).flat();
}

/** session-loader `loadSessionMessagesReadOnly`: the file's message entries in order (the fake journal has no branches). */
export async function loadSessionMessagesReadOnly(file: string): Promise<unknown[]> {
	const messages: unknown[] = [];
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: unknown };
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		} catch {
			// A torn last line, as stock skips it.
		}
	}
	return messages;
}
