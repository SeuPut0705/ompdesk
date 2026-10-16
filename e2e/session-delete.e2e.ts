/** Deleting sessions end to end on the fake omp (session-delete-flow.ts). */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "@playwright/test";
import { fixtureOmp } from "./harness";
import { deleteSessionsEndToEnd } from "./session-delete-flow";

test("deleting sessions removes them from the sidebar and the disk, and a relaunch keeps them gone", async () => {
	test.setTimeout(180_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-delete-")));
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	// The fake omp's journal format: title slot, header, one exchange.
	const seed = async (id: string, cwd: string, title: string, chat: boolean) => {
		const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const at = new Date().toISOString();
		const lines = [
			{ type: "title", v: 1, title, updatedAt: at },
			{ type: "session", version: 3, id, timestamp: at, cwd, ...(chat ? { kind: "chat" } : {}) },
			{
				type: "message",
				id: `${id}-1`,
				parentId: null,
				timestamp: at,
				message: { role: "user", content: title, timestamp: Date.now() },
			},
			{
				type: "message",
				id: `${id}-2`,
				parentId: `${id}-1`,
				timestamp: at,
				message: { role: "assistant", content: [{ type: "text", text: `${title} answer` }], timestamp: Date.now() },
			},
		];
		await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		return file;
	};
	try {
		await deleteSessionsEndToEnd({ desktop, project, agent, work: path.join(root, "work"), env }, seed);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
