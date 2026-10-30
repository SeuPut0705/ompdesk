import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import { ImageBlobCache } from "./image-blob-cache";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, RM_TEMP);
});

function folder(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "omp-image-blobs-"));
	dirs.push(dir);
	return path.join(dir, "blobs");
}

function blob(text: string): { ref: string; data: string; bytes: number } {
	const bytes = Buffer.from(text.repeat(64));
	return {
		ref: `blob:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		data: bytes.toString("base64"),
		bytes: bytes.length,
	};
}

/** A transcript as a host answers it with `imageRefs`: a read and a capture, one picture twice. */
function transcript(...refs: string[]) {
	return refs.map((ref, index) => ({
		role: "toolResult",
		toolCallId: `call-${index}`,
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: ref, mimeType: "image/png" },
		],
		details: { images: [{ data: ref, mimeType: "image/png" }] },
	}));
}

const pictures = (messages: ReturnType<typeof transcript>) =>
	messages.flatMap(message => [message.content[1]?.data, message.details.images[0]?.data]);

/** The host's blob store, counting what the device asked it for. */
function host(...blobs: Array<ReturnType<typeof blob>>) {
	const asked: string[] = [];
	const store = new Map(blobs.map(entry => [entry.ref, entry.data]));
	return {
		asked,
		fetch: async (ref: string) => {
			asked.push(ref);
			return store.get(ref) ?? null;
		},
	};
}

describe("a paired host's subagent pictures on this device", () => {
	it("reads each picture from the host once, for every tab, store reset and relaunch after", async () => {
		const dir = folder();
		const one = blob("one");
		const two = blob("two");
		const remote = host(one, two);
		const first = transcript(one.ref, two.ref, one.ref);
		await new ImageBlobCache(dir).resolve(first, remote.fetch);
		expect(pictures(first)).toEqual([one.data, one.data, two.data, two.data, one.data, one.data]);
		expect(remote.asked).toEqual([one.ref, two.ref]);
		// Another tab, and the same device after a relaunch: from this device's folder.
		const cache = new ImageBlobCache(dir);
		const again = transcript(two.ref, one.ref);
		await cache.resolve(again, remote.fetch);
		expect(pictures(again)).toEqual([two.data, two.data, one.data, one.data]);
		expect(remote.asked).toHaveLength(2);
	});

	it("shares one request between reads of a picture at the same time", async () => {
		const one = blob("one");
		const remote = host(one);
		const cache = new ImageBlobCache(folder());
		const a = transcript(one.ref);
		const b = transcript(one.ref);
		await Promise.all([cache.resolve(a, remote.fetch), cache.resolve(b, remote.fetch)]);
		expect(pictures(a)).toEqual([one.data, one.data]);
		expect(pictures(b)).toEqual([one.data, one.data]);
		expect(remote.asked).toEqual([one.ref]);
	});

	it("leaves a reference the host has no bytes for, or sends other bytes for, and keeps neither", async () => {
		const dir = folder();
		const one = blob("one");
		const gone = blob("gone");
		const cache = new ImageBlobCache(dir);
		const messages = transcript(one.ref, gone.ref);
		// A host that answers another picture under the reference.
		await cache.resolve(messages, async ref => (ref === one.ref ? blob("other").data : null));
		expect(pictures(messages)).toEqual([one.ref, one.ref, gone.ref, gone.ref]);
		expect(() => readdirSync(dir)).toThrow();
		const failing = transcript(one.ref);
		await cache.resolve(failing, async () => {
			throw new Error("remote_offline");
		});
		expect(pictures(failing)).toEqual([one.ref, one.ref]);
	});

	it("lets the least recently read pictures go once the folder is past its bound", async () => {
		const dir = folder();
		const blobs = ["a", "b", "c", "d"].map(blob);
		const remote = host(...blobs);
		// Room for three pictures; past it the folder is trimmed to three quarters of that.
		const cache = new ImageBlobCache(dir, blobs[0].bytes * 3);
		for (const [index, entry] of blobs.slice(0, 3).entries()) {
			await cache.resolve(transcript(entry.ref), remote.fetch);
			const file = path.join(dir, entry.ref.slice("blob:sha256:".length));
			utimesSync(file, new Date(), new Date(Date.now() - (10 - index) * 60_000));
		}
		// `a` is read again (from the folder), so `b` is now the oldest.
		await cache.resolve(transcript(blobs[0].ref), remote.fetch);
		await cache.resolve(transcript(blobs[3].ref), remote.fetch);
		await expect.poll(() => readdirSync(dir).length).toBe(2);
		const kept = readdirSync(dir).map(name => `blob:sha256:${name}`);
		expect(kept.sort()).toEqual([blobs[0].ref, blobs[3].ref].sort());
		for (const name of readdirSync(dir)) expect(statSync(path.join(dir, name)).size).toBe(blobs[0].bytes);
	});
});
