import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * A stock install that serves only the listing modules, like an older or fake
 * omp: the first-prompt fill's session-loader/transcript-entry do not resolve.
 * session-loader is still mapped, to a module that records being imported.
 */
async function listingOnlyInstall(rows: Array<{ path: string; firstMessage: string }>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-helper-"));
	tempDirs.push(dir);
	const root = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
	await fs.mkdir(root, { recursive: true });
	const marker = path.join(dir, "loader-imported");
	await fs.writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			type: "module",
			exports: {
				"./session/session-listing": "./listing.ts",
				"./session/session-storage": "./listing.ts",
				"./session/session-loader": "./loader.ts",
			},
		}),
	);
	const listed = rows.map(row => ({ ...row, id: path.basename(row.path), size: 1, modified: "2026-01-01T00:00:00Z" }));
	await fs.writeFile(
		path.join(root, "listing.ts"),
		`export class FileSessionStorage {}\nexport async function listAllSessions() { return ${JSON.stringify(listed)}; }\n`,
	);
	await fs.writeFile(
		path.join(root, "loader.ts"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\nexport function visitEntriesFromFileStream() {}\n`,
	);
	return { root, marker, sessionsRoot: path.join(dir, "sessions") };
}

function startHelper(root: string): { input: Interface; stderr: () => string } {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts")], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OMP_PACKAGE_ROOT: root },
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += String(chunk);
	});
	return { input: createInterface({ input: child.stdout }), stderr: () => stderr };
}

async function request(helper: Interface, id: number, sessionsRoot: string): Promise<unknown> {
	const child = children.at(-1);
	if (!child) throw new Error("no helper");
	const reply = once(helper, "line");
	child.stdin.write(`${JSON.stringify({ id, method: "sessions.list", params: { sessionsRoot } })}\n`);
	const [line] = await reply;
	return JSON.parse(String(line));
}

describe("stock helper first-prompt fill", () => {
	it("never imports the fill's stock modules when no row needs it", async () => {
		const { root, marker, sessionsRoot } = await listingOnlyInstall([
			{ path: "/s/a.jsonl", firstMessage: "Create the file notes.txt" },
		]);
		const { input } = startHelper(root);
		const reply = await request(input, 1, sessionsRoot);
		expect(reply).toMatchObject({ id: 1, result: [{ firstMessage: "Create the file notes.txt" }] });
		await expect(fs.access(marker)).rejects.toThrow();
	});

	it("returns stock's rows unchanged and logs once when the fill's modules cannot load", async () => {
		const rows = [
			{ path: "/s/hidden.jsonl", firstMessage: "(no messages)" },
			{ path: "/s/plain.jsonl", firstMessage: "hello" },
		];
		const { root, sessionsRoot } = await listingOnlyInstall(rows);
		const { input, stderr } = startHelper(root);
		for (const id of [1, 2]) {
			const reply = await request(input, id, sessionsRoot);
			expect(reply).not.toHaveProperty("error");
			expect(reply).toMatchObject({
				id,
				result: [{ firstMessage: "(no messages)" }, { firstMessage: "hello" }],
			});
		}
		await expect.poll(() => stderr().match(/first-prompt fill unavailable/g)?.length).toBe(1);
	});
});
