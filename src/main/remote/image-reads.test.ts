import { describe, expect, it } from "vitest";
import type { IpcFsReadImageResult } from "../../shared/ipc-types";
import { type ImageRead, RemoteImageReads } from "./image-reads";

/** A host's file as `fs.readImage` answers it, honouring `known` as a current host does unless `older`. */
function host(options: { older?: boolean } = {}) {
	const file = { mtimeMs: 1000, size: 4, dataUrl: "data:image/png;base64,AAAA" };
	const asked: Array<{ mtimeMs: number; size: number } | undefined> = [];
	const pending: Array<() => void> = [];
	let hold = false;
	const read: ImageRead = async known => {
		asked.push(known);
		if (hold) {
			const released = Promise.withResolvers<void>();
			pending.push(released.resolve);
			await released.promise;
		}
		const base = { ok: true, mime: "image/png", size: file.size };
		if (options.older) return { ...base, dataUrl: file.dataUrl };
		if (known && known.mtimeMs === file.mtimeMs && known.size === file.size)
			return { ...base, dataUrl: null, mime: null, mtimeMs: file.mtimeMs, unchanged: true };
		return { ...base, dataUrl: file.dataUrl, mtimeMs: file.mtimeMs };
	};
	return {
		file,
		asked,
		read,
		hold: () => {
			hold = true;
		},
		release: () => {
			hold = false;
			for (const resolve of pending.splice(0)) resolve();
		},
	};
}

describe("a paired host's reply pictures on this device", () => {
	it("reads a picture whole once, then only asks whether it changed", async () => {
		const reads = new RemoteImageReads();
		const remote = host();
		const first = await reads.read("host\0/w\0shot.png", remote.read);
		const second = await reads.read("host\0/w\0shot.png", remote.read);
		expect(second).toEqual(first);
		expect(second.dataUrl).toBe(remote.file.dataUrl);
		expect(second.unchanged).toBeUndefined();
		expect(remote.asked).toEqual([undefined, { mtimeMs: 1000, size: 4 }]);
		// The file changed: its new bytes come, and are what the next read keeps.
		Object.assign(remote.file, { mtimeMs: 2000, dataUrl: "data:image/png;base64,BBBB" });
		expect((await reads.read("host\0/w\0shot.png", remote.read)).dataUrl).toBe("data:image/png;base64,BBBB");
		expect((await reads.read("host\0/w\0shot.png", remote.read)).dataUrl).toBe("data:image/png;base64,BBBB");
		expect(remote.asked.at(-1)).toEqual({ mtimeMs: 2000, size: 4 });
	});

	it("keeps nothing from an older host, which sends no mtime", async () => {
		const reads = new RemoteImageReads();
		const remote = host({ older: true });
		await reads.read("k", remote.read);
		await reads.read("k", remote.read);
		expect(remote.asked).toEqual([undefined, undefined]);
	});

	it("forgets a picture whose read failed", async () => {
		const reads = new RemoteImageReads();
		const remote = host();
		await reads.read("k", remote.read);
		const gone: IpcFsReadImageResult = { ok: false, dataUrl: null, mime: null, size: 0, code: "file_not_found" };
		await expect(reads.read("k", async () => gone)).resolves.toBe(gone);
		await reads.read("k", remote.read);
		expect(remote.asked).toEqual([undefined, undefined]);
	});

	it("shares one request between reads of a picture at the same time", async () => {
		const reads = new RemoteImageReads();
		const remote = host();
		remote.hold();
		const both = Promise.all([reads.read("k", remote.read), reads.read("k", remote.read)]);
		await Promise.resolve();
		remote.release();
		const [a, b] = await both;
		expect(a).toBe(b);
		expect(remote.asked).toEqual([undefined]);
	});

	it("lets the least recently shown picture go past its bound", async () => {
		const reads = new RemoteImageReads(60);
		const remote = host();
		await reads.read("a", remote.read);
		await reads.read("b", remote.read);
		// `a` shown again, so `b` is the oldest when `c` comes.
		await reads.read("a", remote.read);
		await reads.read("c", remote.read);
		remote.asked.length = 0;
		await reads.read("a", remote.read);
		await reads.read("b", remote.read);
		expect(remote.asked).toEqual([{ mtimeMs: 1000, size: 4 }, undefined]);
	});
});
