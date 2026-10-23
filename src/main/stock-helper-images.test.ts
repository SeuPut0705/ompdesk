/**
 * The stock helper's `image.toModel` (resources/gui-bridge/stock-helper/images.ts) on the installed omp: a picture
 * attached on the desktop in a format models refuse comes back as one they take (the composer's IMAGE_TO_MODEL), and
 * one stock cannot read answers an error, which the composer turns into a file attachment.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill();
});

const realRoot = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");

async function toModel(data: string, mimeType: string): Promise<{ result?: { mimeType: string }; error?: string }> {
	const child = spawn("bun", [path.resolve("resources/gui-bridge/stock-helper/host.ts"), "stock"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OMP_PACKAGE_ROOT: realRoot },
	});
	children.push(child);
	child.stderr.resume();
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	child.stdin.write(
		`${JSON.stringify({ id: 1, method: "image.toModel", params: { type: "image", data, mimeType } })}\n`,
	);
	const { value } = await lines.next();
	return JSON.parse(value as string) as { result?: { mimeType: string }; error?: string };
}

/** A 2×2 24-bit BMP, a format no provider takes. */
function bmp(): string {
	const pixels = Buffer.alloc(16, 0x80);
	const header = Buffer.alloc(54);
	header.write("BM", 0);
	header.writeUInt32LE(54 + pixels.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(2, 18);
	header.writeInt32LE(2, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(pixels.length, 34);
	return Buffer.concat([header, pixels]).toString("base64");
}

describe.skipIf(!existsSync(realRoot))("image.toModel on the installed omp", () => {
	it("turns a BMP into a format models take, and refuses bytes that are no picture", async () => {
		const converted = await toModel(bmp(), "image/bmp");
		expect(converted.error).toBeUndefined();
		expect(["image/png", "image/jpeg"]).toContain(converted.result?.mimeType);

		const broken = await toModel(Buffer.from("not a picture").toString("base64"), "image/heic");
		expect(broken.error).toBeTruthy();
	}, 30_000);
});
