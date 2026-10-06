import { describe, expect, it } from "vitest";
import type { RpcChunkFrame } from "../shared/rpc-types";
import { ChunkReassembler, supportsRpcProtocolV2 } from "./rpc-bridge";

const FRAME_BYTES = 1_048_576;
const CHUNK_BYTES = 262_144;

function chunkFrames(payload: Buffer, chunkId = "frame-1"): RpcChunkFrame[] {
	const count = Math.ceil(payload.byteLength / CHUNK_BYTES);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk",

		chunkId,
		index,
		count,
		byteLength: payload.byteLength,
		data: payload.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
	}));
}
describe("supportsRpcProtocolV2", () => {
	it("requires protocol 2 and the exact framing limits", () => {
		expect(
			supportsRpcProtocolV2({
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: FRAME_BYTES,
				maxReassembledFrameBytes: 67_108_864,
			}),
		).toBe(true);
		expect(supportsRpcProtocolV2({ supportedProtocolVersions: [2] })).toBe(false);
		expect(
			supportsRpcProtocolV2({
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: FRAME_BYTES,
				maxReassembledFrameBytes: 1,
			}),
		).toBe(false);
	});
});

describe("ChunkReassembler", () => {
	it("reassembles one bounded, contiguous protocol-v2 frame", () => {
		const payload = Buffer.alloc(FRAME_BYTES, 0x61);
		const decoder = new ChunkReassembler();
		let result: Buffer | null = null;
		for (const frame of chunkFrames(payload)) result = decoder.feed(frame);
		expect(result?.equals(payload)).toBe(true);
		expect(decoder.pending).toBe(false);
	});

	it("rejects malformed or interleaved chunks and releases pending state", () => {
		const payload = Buffer.alloc(FRAME_BYTES, 0x62);
		const frames = chunkFrames(payload);
		const decoder = new ChunkReassembler();

		expect(() => decoder.feed({ ...frames[0], data: "not-base64" })).toThrow("Invalid RPC chunk data");
		expect(decoder.pending).toBe(false);

		expect(decoder.feed(frames[0])).toBeNull();
		expect(() => decoder.feed({ ...frames[1], chunkId: "other-frame" })).toThrow("RPC chunk sequence mismatch");
		expect(decoder.pending).toBe(false);

		expect(() => decoder.feed({ ...frames[0], count: 257 })).toThrow("Invalid RPC chunk metadata");
		expect(decoder.pending).toBe(false);
	});
});
