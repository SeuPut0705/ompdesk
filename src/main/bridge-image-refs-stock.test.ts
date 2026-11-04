import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("sessions.transcript imageRefs (gui-bridge image-refs.ts)", () => {
	it("names each picture by stock's content address, in every position stock externalizes, and changes nothing in place", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-image-refs-"));
		fs.chmodSync(dir, 0o700);
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			fs.copyFileSync("resources/gui-bridge/image-refs.ts", path.join(dir, "image-refs.ts"));
			const picture = Buffer.alloc(4096, 7);
			const base64 = picture.toString("base64");
			const hash = createHash("sha256").update(picture).digest("hex");
			const tiny = Buffer.alloc(300, 1).toString("base64");
			fs.writeFileSync(
				path.join(dir, "check.ts"),
				`
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withImageRefs } from "./image-refs.ts";
const store = new BlobStore("./blobs");
const page = [
	{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: ${JSON.stringify(base64)}, mimeType: "image/png" }] },
	{ role: "toolResult", content: [{ type: "text", text: "made" }], details: { xdev: { inner: { images: [{ data: ${JSON.stringify(base64)}, mimeType: "image/webp" }] } } } },
	{ role: "toolResult", content: [{ type: "image", data: ${JSON.stringify(tiny)}, mimeType: "image/png" }, { type: "image", data: "blob:sha256:${"a".repeat(64)}", mimeType: "image/png" }] },
	{ role: "assistant", content: [{ type: "text", text: "a ${"long ".repeat(300)}text with no picture" }] },
];
const before = JSON.stringify(page);
const shown = withImageRefs(page, store);
const again = withImageRefs(page, store);
console.log(JSON.stringify({
	shown,
	untouched: JSON.stringify(page) === before,
	sameTextMessage: shown[3] === page[3],
	stable: again[0].content[1].data === shown[0].content[1].data,
	stored: (await store.get(shown[0].content[1].data.slice("blob:sha256:".length)))?.toString("base64") === page[0].content[1].data,
}));
`,
			);
			const result = JSON.parse(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					cwd: dir,
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			) as {
				shown: Array<{
					content: Array<{ data?: string }>;
					details?: { xdev: { inner: { images: Array<{ data: string }> } } };
				}>;
				untouched: boolean;
				sameTextMessage: boolean;
				stable: boolean;
				stored: boolean;
			};
			const ref = `blob:sha256:${hash}`;
			expect(result.shown[0]?.content[1]?.data).toBe(ref);
			expect(result.shown[1]?.details?.xdev.inner.images[0]?.data).toBe(ref);
			// Under stock's threshold the bytes stay inline; a reference stays a reference.
			expect(result.shown[2]?.content[0]?.data).toBe(Buffer.alloc(300, 1).toString("base64"));
			expect(result.shown[2]?.content[1]?.data).toBe(`blob:sha256:${"a".repeat(64)}`);
			expect(result.untouched).toBe(true);
			expect(result.sameTextMessage).toBe(true);
			expect(result.stable).toBe(true);
			// The address is the store's: `read_image_blob` answers it with the bytes.
			expect(result.stored).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
