/**
 * `boot.*` against the real shell (PROTOCOL.md §15.3): `omp-media://` answers a player's range requests from disk and
 * serves registered tokens only, until their owner releases them (was `media-stream.test.ts`); keep-awake's blockers are
 * held while started; the resolver and the theme source answer. The lid policy and the Windows lid backend replay their
 * captured TypeScript cases in Rust (`boot_core/lid.rs`, `boot_core/powercfg.rs`): over the wire they would change this
 * machine's power settings, so this shell runs as a test launch (`OMP_GUI_HEADLESS=1`) and holds no lid.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awakeBlocker, type BootClient, bootModule, mediaResponse } from "./boot";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const executable = testShellExecutable();

// EBML header + "webm" doc type, then a counting tail so ranges are checkable.
const WEBM = Uint8Array.from([
	0x1a,
	0x45,
	0xdf,
	0xa3,
	...Buffer.from("webm"),
	...Array.from({ length: 1000 }, (_, i) => i % 256),
]);

describe.skipIf(!executable)("boot over the shell", () => {
	let shell: TestShell;
	let boot: BootClient;
	let dir: string;
	let clip: string;
	let hundred: string;

	beforeAll(async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "boot-parity-"));
		clip = path.join(dir, "clip.webm");
		hundred = path.join(dir, "hundred.webm");
		writeFileSync(clip, WEBM);
		writeFileSync(hundred, WEBM.slice(0, 100));
		process.env.OMP_GUI_HEADLESS = "1";
		shell = await startTestShell(executable as string);
		boot = bootModule(() => shell.client);
	}, 90_000);

	afterAll(async () => {
		await shell?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const open = async (file: string, owner = 1) =>
		(await boot.call("mediaOpen", { path: file, mime: "video/webm", owner })).url;
	const status = async (url: string, method = "GET", range?: string) =>
		(await boot.call("mediaHead", { url, method, ...(range === undefined ? {} : { range }) })).status;

	it("answers a media element's range requests from disk", async () => {
		const url = await open(clip);
		expect(url).toMatch(/^omp-media:\/\/stream\/[\w-]{32}$/);
		const first = await mediaResponse(boot, url, "bytes=0-");
		expect(first.status).toBe(206);
		expect(first.headers.get("content-range")).toBe(`bytes 0-${WEBM.length - 1}/${WEBM.length}`);
		expect(first.headers.get("accept-ranges")).toBe("bytes");
		expect(first.headers.get("content-type")).toBe("video/webm");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(WEBM);
		const middle = await mediaResponse(boot, url, "bytes=100-109");
		expect(middle.status).toBe(206);
		expect(middle.headers.get("content-length")).toBe("10");
		expect(new Uint8Array(await middle.arrayBuffer())).toEqual(WEBM.slice(100, 110));
		const whole = await mediaResponse(boot, url, undefined);
		expect(whole.status).toBe(200);
		expect((await whole.arrayBuffer()).byteLength).toBe(WEBM.length);
		const past = await mediaResponse(boot, url, `bytes=${WEBM.length}-`);
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe(`bytes */${WEBM.length}`);
		const head = await boot.call("mediaHead", { url, method: "HEAD", range: "bytes=0-9" });
		expect(head.status).toBe(206);
		expect(head.length).toBe(0);
	});

	it.each([
		[undefined, 200, null],
		["bytes=0-", 206, "bytes 0-99/100"],
		["bytes=10-19", 206, "bytes 10-19/100"],
		["bytes=90-500", 206, "bytes 90-99/100"],
		["bytes=-10", 206, "bytes 90-99/100"],
		["bytes=-500", 206, "bytes 0-99/100"],
		["bytes=100-", 416, "bytes */100"],
		["bytes=20-10", 416, "bytes */100"],
		["bytes=-0", 416, "bytes */100"],
		["bytes=-", 416, "bytes */100"],
		["items=0-1", 416, "bytes */100"],
		["bytes=0-1,5-6", 416, "bytes */100"],
	])("%s of 100 bytes → %i %s", async (range, expected, contentRange) => {
		const url = await open(hundred);
		const head = await boot.call("mediaHead", { url, ...(range === undefined ? {} : { range }) });
		expect(head.status).toBe(expected);
		expect(Object.fromEntries(head.headers.map(([k, v]) => [k.toLowerCase(), v]))["content-range"] ?? null).toBe(
			contentRange,
		);
	});

	it("serves registered tokens only, and only until their owner releases them", async () => {
		expect(await status("omp-media://stream/guess")).toBe(404);
		expect(await status(`omp-media://stream/${encodeURIComponent(clip)}`)).toBe(404);
		const url = await open(clip, 1);
		const other = await open(clip, 2);
		expect(await status(url, "POST")).toBe(404);
		// Another page cannot release it.
		await boot.post("mediaRelease", { url, owner: 2 });
		expect(await status(url)).toBe(200);
		await boot.post("mediaRelease", { url, owner: 1 });
		expect(await status(url)).toBe(404);
		await boot.post("mediaReleaseOwner", { owner: 2 });
		expect(await status(other)).toBe(404);
		await expect(boot.request("mediaRead", { url: other, offset: 0, length: 10 })).rejects.toMatchObject({
			code: "gone",
		});
	});

	it("holds keep-awake's blocker while any is started, and no lid in a test launch", async () => {
		const warnings: string[] = [];
		const work = awakeBlocker(boot, "work", message => warnings.push(message));
		const host = awakeBlocker(boot, "host", message => warnings.push(message));
		expect(await boot.call("awakeState", {})).toEqual({ held: false, lidHeld: false });
		const a = work.start();
		const b = host.start();
		expect(a).not.toBe(b);
		expect(await boot.call("awakeState", {})).toEqual({ held: true, lidHeld: false });
		work.stop(a);
		expect((await boot.call("awakeState", {})).held).toBe(true);
		host.stop(b);
		expect(await boot.call("awakeState", {})).toEqual({ held: false, lidHeld: false });
		expect(warnings).toEqual([]);
	});

	it("resolves a host name and applies a theme source", async () => {
		const { endpoints } = await boot.call("resolveHost", { host: "localhost" });
		expect(endpoints.length).toBeGreaterThan(0);
		await expect(boot.call("resolveHost", { host: " " })).rejects.toMatchObject({ code: "invalid" });
		await expect(boot.call("themeSource", { source: "dark" })).resolves.toEqual({});
		await expect(boot.call("themeSource", { source: "sepia" as unknown as "dark" })).rejects.toMatchObject({
			code: "invalid",
		});
	});
});
