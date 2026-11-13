/**
 * A player's file is resolved with fs:read-binary's roots and sniffed as audio/video before the shell streams it as
 * `omp-media://` (the stream's own cases: `shell-host/modules/boot.test.ts`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveWorkspaceMedia } from "./workspace-fs";

const root = mkdtempSync(path.join(os.tmpdir(), "omp-media-stream-"));
const workspace = path.join(root, "project");
const outside = path.join(root, "outside.webm");
// EBML header + "webm" doc type, then a counting tail so ranges are checkable.
const WEBM = Uint8Array.from([
	0x1a,
	0x45,
	0xdf,
	0xa3,
	...Buffer.from("webm"),
	...Array.from({ length: 1000 }, (_, i) => i % 256),
]);

writeFileSync(outside, WEBM);
mkdirSync(path.join(workspace, "out"), { recursive: true });
writeFileSync(path.join(workspace, "out", "clip.webm"), WEBM);
writeFileSync(path.join(workspace, "notes.txt"), "plain text\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveWorkspaceMedia", () => {
	it("resolves a workspace file that sniffs as video", async () => {
		await expect(resolveWorkspaceMedia(workspace, "out/clip.webm")).resolves.toEqual({
			ok: true,
			abs: path.join(workspace, "out", "clip.webm"),
			mime: "video/webm",
			size: WEBM.length,
		});
	});

	it("keeps fs:read-binary's roots: relative escapes and missing workspaces are refused", async () => {
		await expect(resolveWorkspaceMedia(workspace, "../outside.webm")).resolves.toMatchObject({
			ok: false,
			code: "path_escapes_workspace",
		});
		await expect(resolveWorkspaceMedia(null, "out/clip.webm")).resolves.toMatchObject({
			ok: false,
			code: "no_workspace",
		});
		await expect(resolveWorkspaceMedia(workspace, "out/gone.webm")).resolves.toMatchObject({
			ok: false,
			code: "file_not_found",
		});
		await expect(resolveWorkspaceMedia(workspace, "")).resolves.toMatchObject({ ok: false, code: "invalid_path" });
		await expect(resolveWorkspaceMedia(workspace, "out")).resolves.toMatchObject({ ok: false, code: "not_a_file" });
	});

	it("never streams a file that is not audio or video", async () => {
		await expect(resolveWorkspaceMedia(workspace, "notes.txt")).resolves.toMatchObject({
			ok: false,
			code: "unsupported",
		});
	});
});
