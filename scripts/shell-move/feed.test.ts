import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";

function read(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		get({ hostname: "127.0.0.1", port, path, rejectUnauthorized: false }, response => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", chunk => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			response.on("error", reject);
		}).on("error", reject);
	});
}

test("the seed feed validates repository access without offering an update or asset", async () => {
	const folder = await mkdtemp(join(tmpdir(), "shell-seed-feed-"));
	const asset = join(folder, "candidate.dmg");
	await writeFile(asset, "isolated candidate bytes");
	const child = spawn(
		"bun",
		["scripts/shell-move/feed.ts", "--setup", asset, "--cert-dir", folder, "--port", "0", "--seed-port", "0"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const ended = once(child, "close");
	let errors = "";
	child.stderr.on("data", chunk => {
		errors += String(chunk);
	});
	try {
		const ports = await new Promise<{ seed: number; update: number }>((resolve, reject) => {
			let seed: number | undefined;
			const lines = createInterface({ input: child.stdout });
			child.once("error", reject);
			child.once("close", code => reject(new Error(`feed exited ${code}: ${errors}`)));
			lines.on("line", line => {
				const value = JSON.parse(line) as { seedListening?: number; listening?: number };
				if (value.seedListening !== undefined) seed = value.seedListening;
				if (seed !== undefined && value.listening !== undefined) resolve({ seed, update: value.listening });
			});
		});
		const base = "/repos/SeuPut0705/ompdesk";
		expect((await read(ports.seed, base)).status).toBe(200);
		expect(await read(ports.seed, `${base}/releases`)).toEqual({ status: 200, body: "[]" });
		expect((await read(ports.seed, `${base}/releases/latest`)).status).toBe(404);
		expect((await read(ports.seed, `${base}/releases/assets/1`)).status).toBe(404);
		expect((await read(ports.update, `${base}/releases/latest`)).status).toBe(200);
	} finally {
		child.kill();
		await ended;
		await rm(folder, { recursive: true, force: true });
	}
});
