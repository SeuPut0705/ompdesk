/**
 * Sending an attached file to a paired host (host-upload.ts): one frame for a file that fits, parts for a larger one,
 * and what an older host that takes no parts says.
 */
import { describe, expect, it } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import { HOST_UPLOAD_FRAME_BYTES, HOST_UPLOAD_MAX_BYTES, HOST_UPLOAD_PART_BYTES } from "../../shared/ipc-types";
import { type HostRequest, uploadToHost } from "./host-upload";

/** A host that takes parts in order and keeps what they build. */
function host(options: { parts?: boolean } = {}) {
	const calls: { method: string; index?: number; bytes: number }[] = [];
	const kept = new Map<string, Buffer[]>();
	const request: HostRequest = async (method, params) => {
		const { dataBase64, upload, index, last } = params as {
			dataBase64: string;
			upload?: string;
			index?: number;
			last?: boolean;
		};
		const bytes = Buffer.from(dataBase64, "base64");
		calls.push({ method, ...(index === undefined ? {} : { index }), bytes: bytes.byteLength });
		if (method === "host.files.upload") return { path: "/host/up/whole" };
		if (options.parts === false) throw codedError("unsupported", "Unknown method host.files.uploadPart");
		const held = kept.get(upload as string) ?? [];
		held.push(bytes);
		kept.set(upload as string, held);
		return last ? { path: `/host/up/${Buffer.concat(held).byteLength}` } : { received: 0 };
	};
	return { calls, request };
}

describe("uploadToHost", () => {
	it("sends a file that fits one frame in one request", async () => {
		const { calls, request } = host();
		expect(await uploadToHost(request, "a.docx", new Uint8Array(HOST_UPLOAD_FRAME_BYTES))).toEqual({
			ok: true,
			path: "/host/up/whole",
		});
		expect(calls.map(call => call.method)).toEqual(["host.files.upload"]);
	});

	it("sends a larger file in ordered parts, each fitting a frame, and answers the last part's path", async () => {
		const { calls, request } = host();
		const size = HOST_UPLOAD_FRAME_BYTES + HOST_UPLOAD_PART_BYTES + 5;
		expect(await uploadToHost(request, "scan.pdf", new Uint8Array(size))).toEqual({
			ok: true,
			path: `/host/up/${size}`,
		});
		expect(calls.map(call => [call.index, call.bytes])).toEqual([
			[0, HOST_UPLOAD_PART_BYTES],
			[1, HOST_UPLOAD_PART_BYTES],
			[2, size - 2 * HOST_UPLOAD_PART_BYTES],
		]);
	});

	it("says an older host takes no large file, and refuses one past the limit without a request", async () => {
		const older = host({ parts: false });
		expect(await uploadToHost(older.request, "scan.pdf", new Uint8Array(HOST_UPLOAD_FRAME_BYTES + 1))).toMatchObject({
			ok: false,
			code: "unsupported",
		});
		const any = host();
		expect(await uploadToHost(any.request, "huge.bin", new Uint8Array(HOST_UPLOAD_MAX_BYTES + 1))).toMatchObject({
			ok: false,
			code: "file_too_large",
		});
		expect(any.calls).toEqual([]);
	});
});
