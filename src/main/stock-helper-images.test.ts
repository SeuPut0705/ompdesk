/**
 * The stock helper's `image.toModel` (resources/gui-bridge/stock-helper/images.ts) on the installed omp: a picture
 * attached on the desktop in a format models refuse comes back as one they take (the composer's IMAGE_TO_MODEL), and
 * one stock cannot read answers an error, which the composer turns into a file attachment.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
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

/** A 2×2 AVIF (encoded once with Bun.Image). */
const AVIF =
	"AAAAIGZ0eXBhdmlmAAAAAE1pUHJhdmlmbWlhZm1pZjEAAAEhbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAAOcGl0bQAAAAAAAQAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAgWlwcnAAAABgaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAACAAAAAgAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAVEAAAAcAAAAAW1kYXQAAAAAAAAALBIACgwAAAAABn/8CBAQNCAyChABmAAQQQQgBUg=";

/**
 * Whether this machine's Bun.Image decodes {@link AVIF}. Bun reads AVIF through the OS: ImageIO on macOS, WIC on
 * Windows (only with the Store's AV1 Video Extension, and a Windows 11 PC that has it still answered
 * ERR_IMAGE_DECODE_FAILED for this picture, as did WIC itself through WPF), never on Linux.
 */
function bunReadsAvif(): boolean {
	const probe = spawnSync(
		"bun",
		["-e", `await new Bun.Image(Buffer.from(${JSON.stringify(AVIF)}, "base64")).png().bytes();`],
		{ encoding: "utf8" },
	);
	return probe.status === 0;
}

describe.skipIf(!existsSync(realRoot))("image.toModel on the installed omp", () => {
	it("turns a BMP and an AVIF into a format models take, and refuses bytes that are no picture", async () => {
		const converted = await toModel(bmp(), "image/bmp");
		expect(converted.error).toBeUndefined();
		expect(["image/png", "image/jpeg"]).toContain(converted.result?.mimeType);
		// A phone's AVIF takes the same road (ws-router.ts convertsForModel). Stock converts with Bun.Image, which reads
		// AVIF only where the OS decodes it (bunReadsAvif): elsewhere it refuses, as for any unread picture.
		const avif = await toModel(AVIF, "image/avif");
		if (!bunReadsAvif()) expect(avif.error).toBeTruthy();
		else {
			expect(avif.error).toBeUndefined();
			expect(["image/png", "image/jpeg"]).toContain(avif.result?.mimeType);
		}

		const broken = await toModel(Buffer.from("not a picture").toString("base64"), "image/heic");
		expect(broken.error).toBeTruthy();
	}, 30_000);
});
