/** Filesystem-backed fake stock exports for the fake omp install, not app logic. */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

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
				const entries = (await readFile(file, "utf8"))
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line));
				const header = entries.find(entry => entry.type === "session");
				if (!header) return null;
				const messages = entries.filter(entry => entry.type === "message");
				const title = [...entries].reverse().find(entry => entry.type === "title")?.title;
				const stamp = await stat(file);
				const user = messages.find(entry => entry.message.role === "user")?.message.content;
				const firstMessage =
					typeof user === "string"
						? user
						: (user?.find((part: { type: string }) => part.type === "text")?.text ?? "");
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
					status: messages.at(-1)?.message.role === "assistant" ? "complete" : "pending",
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
