import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codedError } from "../shared/ipc-error-codes";
import { HOST_DOWNLOAD_MAX_BYTES, HOST_DOWNLOAD_PART_BYTES, type IpcFsReadBinaryResult } from "../shared/ipc-types";
import { fileNameOf, SAVE_COPY_TEMP_SUFFIX, type SaveCopyRemote, saveCopy } from "./save-copy";

let dir: string;
let source: string;
let out: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "save-copy-"));
	source = join(dir, "source");
	out = join(dir, "out");
	mkdirSync(source);
	mkdirSync(out);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const pattern = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 251);

function slice(bytes: Uint8Array, offset: number, length: number, size = bytes.length): IpcFsReadBinaryResult {
	const data = bytes.slice(offset, offset + length);
	return { ok: true, data, mime: "application/octet-stream", size, truncated: offset + data.length < size };
}

const refusal = (code: IpcFsReadBinaryResult["code"], error: string, size = 0): IpcFsReadBinaryResult => ({
	ok: false,
	data: new Uint8Array(0),
	mime: "application/octet-stream",
	size,
	truncated: false,
	error,
	...(code ? { code } : {}),
});

/** A host that serves `bytes` in parts; `readRange` is a spy so a test can see every request and break one. */
function hostOf(bytes: Uint8Array, readRange?: SaveCopyRemote["readRange"]) {
	const remote = {
		readRange: vi.fn<SaveCopyRemote["readRange"]>(
			readRange ?? (async (offset, length) => slice(bytes, offset, length)),
		),
		readWhole: vi.fn<SaveCopyRemote["readWhole"]>(async () => slice(bytes, 0, bytes.length)),
	};
	return remote;
}

const picks = (dest: string | null) => vi.fn(async (_defaultName: string) => dest);
const remoteSource = (remote: SaveCopyRemote) => ({ kind: "remote" as const, remote });

describe("fileNameOf", () => {
	it("takes the last segment of a path from either kind of computer", () => {
		expect(fileNameOf("/home/me/out/report.pdf")).toBe("report.pdf");
		expect(fileNameOf("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
		expect(fileNameOf("report.pdf")).toBe("report.pdf");
		expect(fileNameOf("/home/me/folder/")).toBe("folder");
	});
});

describe("saveCopy of a file on this computer", () => {
	it("offers the file's name and copies it to the chosen destination", async () => {
		const bytes = pattern(5000);
		writeFileSync(join(source, "report.bin"), bytes);
		const dest = join(out, "copy.bin");
		const pick = picks(dest);
		await expect(
			saveCopy({
				name: "report.bin",
				pickDestination: pick,
				source: { kind: "local", abs: join(source, "report.bin") },
			}),
		).resolves.toEqual({ ok: true, savedTo: dest });
		expect(pick).toHaveBeenCalledWith("report.bin");
		expect(new Uint8Array(readFileSync(dest))).toEqual(bytes);
	});

	it("writes nothing when the dialog is cancelled", async () => {
		writeFileSync(join(source, "report.bin"), pattern(10));
		await expect(
			saveCopy({
				name: "report.bin",
				pickDestination: picks(null),
				source: { kind: "local", abs: join(source, "report.bin") },
			}),
		).resolves.toEqual({ ok: false, cancelled: true });
		expect(readdirSync(out)).toEqual([]);
	});

	it("answers file_not_found for a file that vanished and leaves no destination", async () => {
		const result = await saveCopy({
			name: "gone.bin",
			pickDestination: picks(join(out, "copy.bin")),
			source: { kind: "local", abs: join(source, "gone.bin") },
		});
		expect(result).toMatchObject({ ok: false, code: "file_not_found" });
		expect(readdirSync(out)).toEqual([]);
	});
});

describe("saveCopy of a file on a paired host", () => {
	const PART = HOST_DOWNLOAD_PART_BYTES;

	it("reassembles three parts byte for byte, leaving no temp file", async () => {
		const bytes = pattern(PART * 2 + 1234);
		const remote = hostOf(bytes);
		const dest = join(out, "big.bin");
		await expect(
			saveCopy({ name: "big.bin", pickDestination: picks(dest), source: remoteSource(remote) }),
		).resolves.toEqual({ ok: true, savedTo: dest });
		// A small first read learns the file before the dialog; full parts follow.
		const probe = 64 * 1024;
		expect(remote.readRange.mock.calls).toEqual([
			[0, probe],
			[probe, PART],
			[probe + PART, PART + 1234 - probe],
		]);
		expect(remote.readWhole).not.toHaveBeenCalled();
		expect(readdirSync(out)).toEqual(["big.bin"]);
		expect(Buffer.compare(readFileSync(dest), bytes)).toBe(0);
	});

	it("keeps the temp file out of the destination until the last part landed", async () => {
		const bytes = pattern(PART + 10);
		const dest = join(out, "big.bin");
		const seen: string[][] = [];
		const remote = hostOf(bytes, async (offset, length) => {
			if (offset > 0) seen.push(readdirSync(out));
			return slice(bytes, offset, length);
		});
		await saveCopy({ name: "big.bin", pickDestination: picks(dest), source: remoteSource(remote) });
		expect(seen).toEqual([[`big.bin${SAVE_COPY_TEMP_SUFFIX}`]]);
	});

	it("saves an empty file", async () => {
		const dest = join(out, "empty.txt");
		const remote = hostOf(new Uint8Array(0));
		await expect(
			saveCopy({ name: "empty.txt", pickDestination: picks(dest), source: remoteSource(remote) }),
		).resolves.toEqual({ ok: true, savedTo: dest });
		expect(readFileSync(dest)).toHaveLength(0);
		expect(readdirSync(out)).toEqual(["empty.txt"]);
	});

	it("leaves no destination and no temp file when a middle part fails", async () => {
		const bytes = pattern(PART * 2 + 50);
		const remote = hostOf(bytes, async (offset, length) => {
			if (offset > PART) throw codedError("remote_offline", "The link dropped");
			return slice(bytes, offset, length);
		});
		const result = await saveCopy({
			name: "big.bin",
			pickDestination: picks(join(out, "big.bin")),
			source: remoteSource(remote),
		});
		expect(result).toMatchObject({ ok: false, code: "remote_offline" });
		expect(readdirSync(out)).toEqual([]);
	});

	it("treats a host's in-band refusal mid-file the same way", async () => {
		const bytes = pattern(PART + 50);
		const remote = hostOf(bytes, async (offset, length) =>
			offset === 0 ? slice(bytes, offset, length) : refusal("file_not_found", "File vanished"),
		);
		const result = await saveCopy({
			name: "big.bin",
			pickDestination: picks(join(out, "big.bin")),
			source: remoteSource(remote),
		});
		expect(result).toMatchObject({
			ok: false,
			code: "file_not_found",
			error: expect.stringContaining("File vanished"),
		});
		expect(readdirSync(out)).toEqual([]);
	});

	it("refuses a file that changed size while it was being saved", async () => {
		const bytes = pattern(PART + 50);
		const remote = hostOf(bytes, async (offset, length) =>
			slice(bytes, offset, length, offset === 0 ? bytes.length : bytes.length + 1),
		);
		const result = await saveCopy({
			name: "big.bin",
			pickDestination: picks(join(out, "big.bin")),
			source: remoteSource(remote),
		});
		expect(result.ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it("refuses a host that stops sending before the file is whole", async () => {
		const bytes = pattern(PART + 50);
		const remote = hostOf(bytes, async (offset, length) =>
			offset === 0 ? slice(bytes, offset, length) : slice(new Uint8Array(0), 0, length, bytes.length),
		);
		const result = await saveCopy({
			name: "big.bin",
			pickDestination: picks(join(out, "big.bin")),
			source: remoteSource(remote),
		});
		expect(result.ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it("refuses a file past the limit before the dialog or any write", async () => {
		const first = slice(pattern(16), 0, 16, HOST_DOWNLOAD_MAX_BYTES + 1);
		const remote = hostOf(new Uint8Array(0), async () => first);
		const pick = picks(join(out, "huge.bin"));
		const result = await saveCopy({ name: "huge.bin", pickDestination: pick, source: remoteSource(remote) });
		expect(result).toMatchObject({ ok: false, code: "file_too_large" });
		expect(pick).not.toHaveBeenCalled();
		expect(remote.readRange).toHaveBeenCalledTimes(1);
		expect(readdirSync(out)).toEqual([]);
	});

	it("takes a file exactly at the limit (the size is checked, not the part count)", async () => {
		const first = slice(pattern(16), 0, 16, HOST_DOWNLOAD_MAX_BYTES);
		const remote = hostOf(new Uint8Array(0), async offset =>
			offset === 0 ? first : refusal("remote_offline", "stop here"),
		);
		const pick = picks(join(out, "edge.bin"));
		await saveCopy({ name: "edge.bin", pickDestination: pick, source: remoteSource(remote) });
		expect(pick).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the dialog is cancelled", async () => {
		const remote = hostOf(pattern(100));
		await expect(
			saveCopy({ name: "a.bin", pickDestination: picks(null), source: remoteSource(remote) }),
		).resolves.toEqual({ ok: false, cancelled: true });
		expect(readdirSync(out)).toEqual([]);
	});

	it("reports a destination it cannot write without throwing, leaving nothing behind", async () => {
		const remote = hostOf(pattern(100));
		const result = await saveCopy({
			name: "a.bin",
			pickDestination: picks(join(out, "no-such-folder", "a.bin")),
			source: remoteSource(remote),
		});
		expect(result.ok).toBe(false);
		expect(readdirSync(out)).toEqual([]);
	});

	it("passes a host's refusal of the first part through with its code, before any dialog", async () => {
		const remote = hostOf(new Uint8Array(0), async () => refusal("not_a_file", "Not a file"));
		const pick = picks(join(out, "a.bin"));
		const result = await saveCopy({ name: "a.bin", pickDestination: pick, source: remoteSource(remote) });
		expect(result).toMatchObject({ ok: false, code: "not_a_file" });
		expect(pick).not.toHaveBeenCalled();
	});

	describe("from a host without host.fs.readRange", () => {
		const older = (whole: IpcFsReadBinaryResult) => ({
			readRange: vi.fn<SaveCopyRemote["readRange"]>(async () => {
				throw codedError("unsupported", "Unknown method host.fs.readRange");
			}),
			readWhole: vi.fn<SaveCopyRemote["readWhole"]>(async () => whole),
		});

		it("saves a file that fits one readBinary", async () => {
			const bytes = pattern(70_000);
			const remote = older(slice(bytes, 0, bytes.length));
			const dest = join(out, "small.bin");
			await expect(
				saveCopy({ name: "small.bin", pickDestination: picks(dest), source: remoteSource(remote) }),
			).resolves.toEqual({ ok: true, savedTo: dest });
			expect(remote.readRange).toHaveBeenCalledTimes(1);
			expect(readdirSync(out)).toEqual(["small.bin"]);
			expect(new Uint8Array(readFileSync(dest))).toEqual(bytes);
		});

		it("asks for an update when the file is past one frame", async () => {
			const remote = older(refusal("file_too_large", "File is too big", 50 * 1024 * 1024));
			const pick = picks(join(out, "movie.mp4"));
			const result = await saveCopy({ name: "movie.mp4", pickDestination: pick, source: remoteSource(remote) });
			expect(result).toMatchObject({
				ok: false,
				code: "unsupported",
				error: expect.stringContaining("Update OMPdesk"),
			});
			expect(pick).not.toHaveBeenCalled();
			expect(readdirSync(out)).toEqual([]);
		});

		it("passes any other refusal of the whole read through", async () => {
			const remote = older(refusal("file_not_found", "No such file"));
			const result = await saveCopy({
				name: "a.bin",
				pickDestination: picks(join(out, "a.bin")),
				source: remoteSource(remote),
			});
			expect(result).toMatchObject({ ok: false, code: "file_not_found" });
		});

		it("writes nothing when the dialog is cancelled", async () => {
			const remote = older(slice(pattern(10), 0, 10));
			await expect(
				saveCopy({ name: "a.bin", pickDestination: picks(null), source: remoteSource(remote) }),
			).resolves.toEqual({ ok: false, cancelled: true });
			expect(readdirSync(out)).toEqual([]);
		});
	});
});
