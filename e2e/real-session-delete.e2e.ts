/**
 * Deleting sessions end to end on the system omp in an isolated profile
 * (session-delete-flow.ts): stock `new_session` / `drop_session`, the bridge's
 * guarded stock `deleteSessionWithArtifacts` and the stock helper's stored
 * deletion are the real ones. No model is called: each session holds a user
 * turn and a `!` bash run, which a session opens without restoring a model.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { realOmpProfile } from "./real-omp";
import { deleteSessionsEndToEnd } from "./session-delete-flow";

test("real omp: deleting sessions removes them from the sidebar and the disk, and a relaunch keeps them gone", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in real omp audit");
	test.setTimeout(300_000);
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	// Stock's own header shape (the title in the header); the artifacts directory goes with the file.
	const seed = async (id: string, cwd: string, title: string, chat: boolean) => {
		const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
		await fs.mkdir(file.slice(0, -".jsonl".length), { recursive: true });
		const at = new Date().toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: at, cwd, title, ...(chat ? { kind: "chat" } : {}) },
			{
				type: "message",
				id: `${id.slice(-4)}0001`,
				parentId: null,
				timestamp: at,
				message: { role: "user", content: [{ type: "text", text: `${title} question` }], timestamp: Date.now() },
			},
			{
				type: "message",
				id: `${id.slice(-4)}0002`,
				parentId: `${id.slice(-4)}0001`,
				timestamp: at,
				message: {
					role: "bashExecution",
					command: "true",
					output: title,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: Date.now(),
				},
			},
		];
		await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	};
	try {
		await deleteSessionsEndToEnd({ desktop, project, agent, work: path.resolve(agent, "..", "work"), env }, seed);
		// Every seeded file and its artifacts directory is gone (stock's `.…lock.os` lease files stay).
		// Stock writes each tab's replacement beside the session it left: header-only, unlisted.
		const left = await fs.readdir(path.join(agent, "sessions", "seeded"));
		expect(left.filter(name => name.startsWith("01a11000-"))).toEqual([]);
	} finally {
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
