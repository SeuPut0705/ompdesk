import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** A stock install whose `HistoryStorage` keeps rows in a file and whose session scan runs until `release` exists. */
async function install(rows: Array<{ prompt: string; cwd?: string }>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-helper-history-"));
	tempDirs.push(dir);
	const root = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	await fs.mkdir(root, { recursive: true });
	const store = path.join(dir, "history.json");
	const release = path.join(dir, "release");
	await fs.writeFile(store, JSON.stringify(rows));
	await fs.writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			type: "module",
			exports: {
				"./session/history-storage": "./history.ts",
				"./session/session-listing": "./listing.ts",
				"./session/session-storage": "./listing.ts",
			},
		}),
	);
	await fs.writeFile(
		path.join(root, "history.ts"),
		`import { readFileSync } from "node:fs";
const rows = () => JSON.parse(readFileSync(${JSON.stringify(store)}, "utf8"));
export class HistoryStorage {
	static open() { return new HistoryStorage(); }
	getRecent(limit, filter) { return rows().filter(row => !filter.cwd || row.cwd === filter.cwd).slice(0, limit); }
	search(query, limit, filter) { return rows().filter(row => row.prompt.includes(query) && (!filter.cwd || row.cwd === filter.cwd)).slice(0, limit); }
}
`,
	);
	await fs.writeFile(
		path.join(root, "listing.ts"),
		`import { existsSync } from "node:fs";
export class FileSessionStorage {}
export async function listAllSessions() {
	while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
	return [];
}
`,
	);
	return { root, store, release };
}

function startHelper(root: string) {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	child.stderr.resume();
	const replies = new Map<number, Promise<{ result?: unknown; error?: string }>>();
	const waiting = new Map<number, (reply: { result?: unknown; error?: string }) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		const reply = JSON.parse(line) as { id: number; result?: unknown; error?: string };
		waiting.get(reply.id)?.(reply);
	});
	return (id: number, method: string, params: unknown) => {
		const { promise, resolve } = Promise.withResolvers<{ result?: unknown; error?: string }>();
		waiting.set(id, resolve);
		replies.set(id, promise);
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		return promise;
	};
}

describe("stock helper history reads", () => {
	it("answers recent and search from stock's HistoryStorage, per workspace, and sees a later write", async () => {
		const { root, store } = await install([
			{ prompt: "newest in b", cwd: "/b" },
			{ prompt: "older in a", cwd: "/a" },
		]);
		const ask = startHelper(root);
		expect(await ask(1, "history.recent", { limit: 10 })).toEqual({
			id: 1,
			result: [
				{ prompt: "newest in b", cwd: "/b" },
				{ prompt: "older in a", cwd: "/a" },
			],
		});
		expect(await ask(2, "history.recent", { limit: 10, cwd: "/a" })).toMatchObject({
			result: [{ prompt: "older in a" }],
		});
		expect(await ask(3, "history.search", { query: "older", limit: 5 })).toMatchObject({
			result: [{ prompt: "older in a" }],
		});
		await fs.writeFile(store, JSON.stringify([{ prompt: "written by another omp", cwd: "/a" }]));
		expect(await ask(4, "history.recent", {})).toMatchObject({ result: [{ prompt: "written by another omp" }] });
		expect(await ask(5, "history.search", { limit: 5 })).toMatchObject({ error: "history.search needs a query" });
	});

	it("answers beside a session scan that holds the stock lane", async () => {
		const { root, release } = await install([{ prompt: "ready" }]);
		const ask = startHelper(root);
		const scan = ask(1, "sessions.list", { sessionsRoot: path.join(path.dirname(root), "sessions") });
		// The scan has the lane and is still running; the read must not wait for it.
		expect(await ask(2, "history.recent", { limit: 5 })).toEqual({ id: 2, result: [{ prompt: "ready" }] });
		await fs.writeFile(release, "");
		expect(await scan).toMatchObject({ id: 1 });
	});

	it("refuses an omp whose HistoryStorage cannot read", async () => {
		const { root } = await install([]);
		await fs.writeFile(
			path.join(root, "history.ts"),
			"export class HistoryStorage { static open() { return {}; } }\n",
		);
		const ask = startHelper(root);
		expect(await ask(1, "history.recent", {})).toEqual({
			id: 1,
			error: "Installed omp's HistoryStorage cannot read history",
		});
	});
});
