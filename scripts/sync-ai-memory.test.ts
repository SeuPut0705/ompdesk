import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	binaryPath,
	extractBinary,
	parseSha256File,
	readPin,
	releaseUrl,
	sha256,
	verifyArchive,
	writeAtomic,
} from "./sync-ai-memory";

const BYTES = Buffer.from("fake ai-memory binary");

/** A one-entry ustar archive (checksum left blank: the reader never checks it). */
function tarGz(name: string, data: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("0", 156);
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

/** A one-entry zip, stored or deflated. */
function zip(name: string, data: Buffer, deflate: boolean): Buffer {
	const body = deflate ? deflateRawSync(data) : data;
	const method = deflate ? 8 : 0;
	const nameBytes = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	const directoryAt = local.length + nameBytes.length + body.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + nameBytes.length, 12);
	end.writeUInt32LE(directoryAt, 16);
	return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

describe("sync-ai-memory helpers", () => {
	it("places each platform's binary under resources/ai-memory-bin/<platform>-<arch>/", () => {
		const pin = readPin();
		expect(binaryPath("darwin", "arm64", pin, "/bin")).toBe(path.join("/bin", "darwin-arm64", "ai-memory"));
		expect(binaryPath("win32", "x64", pin, "/bin")).toBe(path.join("/bin", "win32-x64", "ai-memory.exe"));
		expect(() => binaryPath("linux", "x64", pin)).toThrow(/no linux-x64 entry/);
	});

	it("reads a published .sha256 in sha256sum or bare form and refuses anything else", () => {
		const hash = sha256(BYTES);
		expect(parseSha256File(`${hash}  ai-memory.tar.gz\n`)).toBe(hash);
		expect(parseSha256File(`${hash.toUpperCase()}\n`)).toBe(hash);
		expect(() => parseSha256File("<html>not found</html>")).toThrow(/not a SHA-256/);
		expect(() => parseSha256File("")).toThrow(/not a SHA-256/);
	});

	it("names the release download URL", () => {
		expect(releaseUrl("3.1.1", "a.zip")).toBe(
			"https://github.com/akitaonrails/ai-memory/releases/download/v3.1.1/a.zip",
		);
	});

	it("accepts an archive only when published, pinned and downloaded hashes agree", () => {
		const hash = sha256(BYTES);
		expect(verifyArchive("a", BYTES, hash, hash)).toBe(hash);
		expect(() => verifyArchive("a", BYTES, "0".repeat(64), hash)).toThrow(
			/published SHA-256 .* differs from the pin/,
		);
		expect(() => verifyArchive("a", Buffer.from("other"), hash, hash)).toThrow(/downloaded bytes hash to/);
	});

	it("extracts the one binary from a tar.gz (with ./) and a zip (stored and deflated)", () => {
		expect(extractBinary("x.tar.gz", tarGz("./ai-memory", BYTES), "ai-memory")).toEqual(BYTES);
		expect(extractBinary("x.zip", zip("ai-memory.exe", BYTES, false), "ai-memory.exe")).toEqual(BYTES);
		expect(extractBinary("x.zip", zip("ai-memory.exe", BYTES, true), "ai-memory.exe")).toEqual(BYTES);
		expect(() => extractBinary("x.tar.gz", tarGz("./other", BYTES), "ai-memory")).toThrow(/not in the tar/);
		expect(() => extractBinary("x.zip", zip("other.exe", BYTES, true), "ai-memory.exe")).toThrow(/not in the zip/);
		expect(() => extractBinary("x.7z", BYTES, "ai-memory")).toThrow(/unknown archive type/);
	});

	it("writes atomically, executable, and leaves no temp file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-sync-"));
		try {
			const file = path.join(dir, "nested", "ai-memory");
			writeAtomic(file, BYTES);
			expect(fs.readFileSync(file)).toEqual(BYTES);
			if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o755);
			expect(fs.readdirSync(path.dirname(file))).toEqual(["ai-memory"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
