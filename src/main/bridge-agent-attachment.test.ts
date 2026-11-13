/**
 * gui-bridge agent-control.ts `agent_control.attachment`: one attachment of `ompdesk_session_send` / `ompdesk_report`
 * read where the caller's omp runs (a file in its folder, or the n-th newest picture of its conversation), and
 * `agent_control.mail` taking a report whose content carries picture blocks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { install, methods } from "../../resources/gui-bridge/agent-control";
import { ATTACHMENT_MAX_BYTES, MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];

const sendMessage = vi.fn();
install({ on: () => undefined, sendMessage });

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("png bytes")]);
const JPEG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("jpeg bytes")]);
const PDF = Buffer.from("%PDF-1.7 a spec");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = (bytes: Buffer, mimeType: string) => ({ type: "image", data: bytes.toString("base64"), mimeType });

let folder: string;
beforeAll(() => {
	folder = mkdtempSync(join(tmpdir(), "bridge-attachment-"));
	writeFileSync(join(folder, "spec.pdf"), PDF);
	writeFileSync(join(folder, "shot.png"), PNG);
	// A picture whose extension lies: its bytes say what it is.
	writeFileSync(join(folder, "photo.txt"), JPEG);
	writeFileSync(join(folder, "huge.bin"), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));
	writeFileSync(join(folder, "exact.bin"), Buffer.alloc(ATTACHMENT_MAX_BYTES));
	mkdirSync(join(folder, "sub"));
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function env(messages: unknown[] = []): BridgeEnv {
	return {
		session: () => ({
			isStreaming: false,
			messages,
			sessionManager: { getCwd: () => folder, getBranch: () => [] },
		}),
		emit: () => undefined,
	} as unknown as BridgeEnv;
}

const attachment = methods["agent_control.attachment"];

describe("agent_control.attachment of a file", () => {
	it("reads a file by absolute path or relative to the session's folder, with its SHA-256", async () => {
		const absolute = await attachment?.({ path: join(folder, "spec.pdf") }, env());
		expect(absolute).toEqual({
			name: "spec.pdf",
			mimeType: "application/pdf",
			dataBase64: PDF.toString("base64"),
			sha256: sha(PDF),
		});
		expect(await attachment?.({ path: "spec.pdf" }, env())).toEqual(absolute);
	});

	it("names a picture by its bytes, whatever its extension", async () => {
		expect(await attachment?.({ path: "shot.png" }, env())).toMatchObject({ mimeType: "image/png" });
		expect(await attachment?.({ path: "photo.txt" }, env())).toMatchObject({ mimeType: "image/jpeg" });
	});

	it("refuses a folder, a missing file and a file over the cap, and takes one of exactly the cap", async () => {
		await expect(attachment?.({ path: "sub" }, env())).rejects.toThrow(/is not a file/);
		await expect(attachment?.({ path: "nope.pdf" }, env())).rejects.toThrow(/ENOENT/);
		await expect(attachment?.({ path: "huge.bin" }, env())).rejects.toThrow(/at most 10485760 bytes \(10 MiB\)/);
		const exact = (await attachment?.({ path: "exact.bin" }, env())) as { dataBase64: string };
		expect(Buffer.from(exact.dataBase64, "base64")).toHaveLength(ATTACHMENT_MAX_BYTES);
	});

	it("needs exactly one of path and image", async () => {
		await expect(attachment?.({}, env())).rejects.toThrow(/{path} or {image}/);
		await expect(attachment?.({ path: "spec.pdf", image: 1 }, env())).rejects.toThrow(/{path} or {image}/);
		await expect(attachment?.({ image: 0 }, env())).rejects.toThrow(/{path} or {image}/);
	});
});

describe("agent_control.attachment of a conversation picture", () => {
	// Oldest first, as stock keeps them: the person's first picture, a tool's, then the person's newest.
	const conversation = [
		{ role: "user", content: [{ type: "text", text: "look" }, image(PNG, "image/png")] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "toolResult", content: [image(JPEG, "image/jpeg")] },
		{
			role: "user",
			content: [image(Buffer.from("gif89a-bytes"), "image/gif"), image(Buffer.from("webp-bytes"), "image/webp")],
		},
	];

	it("counts the newest picture as 1, a person's and a tool's alike", async () => {
		expect(await attachment?.({ image: 1 }, env(conversation))).toMatchObject({
			name: "image-1.webp",
			mimeType: "image/webp",
			sha256: sha(Buffer.from("webp-bytes")),
		});
		expect(await attachment?.({ image: 2 }, env(conversation))).toMatchObject({ mimeType: "image/gif" });
		expect(await attachment?.({ image: 3 }, env(conversation))).toMatchObject({
			name: "image-3.jpg",
			sha256: sha(JPEG),
		});
		expect(await attachment?.({ image: 4 }, env(conversation))).toMatchObject({ sha256: sha(PNG) });
	});

	it("says how many pictures the conversation holds when there is no such one", async () => {
		await expect(attachment?.({ image: 5 }, env(conversation))).rejects.toThrow(
			"this conversation holds 4 pictures, so there is no image 5",
		);
		await expect(attachment?.({ image: 1 }, env([]))).rejects.toThrow("holds 0 pictures");
	});

	it("refuses a picture over the cap", async () => {
		const big = [{ role: "user", content: [image(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1), "image/png")] }];
		await expect(attachment?.({ image: 1 }, env(big))).rejects.toThrow(/at most 10485760 bytes/);
	});
});

describe("agent_control.mail with pictures", () => {
	const mail = methods["agent_control.mail"];

	it("hands text and picture blocks to stock as the custom message's content", async () => {
		sendMessage.mockClear();
		const content = [
			{ type: "text", text: "<ompdesk-mail>look</ompdesk-mail>" },
			{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
		];
		await mail?.({ content, details: { id: "p1", kind: "done" }, triggerTurn: true, deliverAs: "aside" }, env());
		expect(sendMessage).toHaveBeenLastCalledWith(
			{ customType: MAIL_CUSTOM_TYPE, content, display: true, details: { id: "p1", kind: "done" } },
			{ triggerTurn: true, deliverAs: "aside" },
		);
	});

	it("refuses content that holds no text", async () => {
		await expect(
			mail?.(
				{
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					details: { id: "p2" },
					triggerTurn: true,
				},
				env(),
			),
		).rejects.toThrow("agent_control.mail needs content");
	});
});
