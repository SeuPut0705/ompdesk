/**
 * NDJSON framing and v2 chunk reassembly for the RPC sidecar stdout stream.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { RpcChunkFrame } from "../shared/rpc-types";

export const RPC_MAX_FRAME_BYTES = 1_048_576;
export const RPC_MAX_REASSEMBLED_BYTES = 67_108_864;
const CHUNK_PAYLOAD_BYTES = 262_144;
const MAX_CHUNK_COUNT = Math.ceil(RPC_MAX_REASSEMBLED_BYTES / CHUNK_PAYLOAD_BYTES);

/** Negotiate v2 only when both peers agree on the framing limits. */
export function supportsRpcProtocolV2(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const ready = value as Record<string, unknown>;
	return (
		Array.isArray(ready.supportedProtocolVersions) &&
		ready.supportedProtocolVersions.includes(2) &&
		ready.maxFrameBytes === RPC_MAX_FRAME_BYTES &&
		ready.maxReassembledFrameBytes === RPC_MAX_REASSEMBLED_BYTES
	);
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	receivedBytes: number;
	chunks: Buffer[];
}

function decodeBase64(data: unknown): Buffer {
	if (
		typeof data !== "string" ||
		data.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	) {
		throw new Error("Invalid RPC chunk data");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("Invalid RPC chunk data");
	return bytes;
}

/**
 * Reassembles one v2 chunk sequence. The server writes a sequence contiguously;
 * rejecting interleaving keeps retained memory bounded to one logical frame.
 */
export class ChunkReassembler {
	#pending: PendingChunks | undefined;

	feed(frame: RpcChunkFrame): Buffer | null {
		try {
			const { chunkId, index, count, byteLength } = frame;
			if (
				typeof chunkId !== "string" ||
				chunkId.length === 0 ||
				chunkId.length > 128 ||
				!Number.isSafeInteger(index) ||
				!Number.isSafeInteger(count) ||
				!Number.isSafeInteger(byteLength) ||
				index < 0 ||
				count < 2 ||
				count > MAX_CHUNK_COUNT ||
				byteLength < RPC_MAX_FRAME_BYTES ||
				byteLength > RPC_MAX_REASSEMBLED_BYTES
			) {
				throw new Error("Invalid RPC chunk metadata");
			}
			const bytes = decodeBase64(frame.data);
			if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) {
				throw new Error("RPC chunk payload exceeds the transport limit");
			}
			if (!this.#pending) {
				if (index !== 0) throw new Error("RPC chunk sequence must start at index 0");
				this.#pending = { chunkId, count, byteLength, nextIndex: 0, receivedBytes: 0, chunks: [] };
			}
			const pending = this.#pending;
			if (
				pending.chunkId !== chunkId ||
				pending.count !== count ||
				pending.byteLength !== byteLength ||
				pending.nextIndex !== index
			) {
				throw new Error("RPC chunk sequence mismatch");
			}
			pending.chunks.push(bytes);
			pending.receivedBytes += bytes.byteLength;
			pending.nextIndex++;
			if (pending.receivedBytes > pending.byteLength) {
				throw new Error("RPC chunk sequence exceeds declared length");
			}
			if (pending.nextIndex < pending.count) return null;
			if (pending.receivedBytes !== pending.byteLength) {
				throw new Error("RPC chunk sequence length mismatch");
			}
			this.#pending = undefined;
			return Buffer.concat(pending.chunks, pending.byteLength);
		} catch (error) {
			this.#pending = undefined;
			throw error;
		}
	}

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	clear(): void {
		this.#pending = undefined;
	}
}

export type FrameHandler = (frame: unknown) => void;

/**
 * Attaches a readline-based NDJSON parser to a readable stream.
 * Handles v2 chunk reassembly transparently.
 */
export function attachNdjsonParser(stream: Readable, onFrame: FrameHandler): () => void {
	const reassembler = new ChunkReassembler();
	const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	const handleLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			reassembler.clear();
			return;
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			reassembler.clear();
			return;
		}

		const obj = parsed as Record<string, unknown>;
		if (obj.type === "rpc_chunk") {
			try {
				const full = reassembler.feed(obj as unknown as RpcChunkFrame);
				if (full) {
					const text = new TextDecoder("utf-8", { fatal: true }).decode(full);
					const reassembled: unknown = JSON.parse(text);
					if (typeof reassembled === "object" && reassembled !== null && !Array.isArray(reassembled)) {
						onFrame(reassembled);
					}
				}
			} catch {
				reassembler.clear();
			}
			return;
		}

		// Protocol v2 sequences are contiguous. A normal frame interrupts and
		// invalidates an incomplete sequence, but remains independently usable.
		if (reassembler.pending) reassembler.clear();
		onFrame(parsed);
	};

	rl.on("line", handleLine);

	return () => {
		rl.close();
		reassembler.clear();
	};
}
