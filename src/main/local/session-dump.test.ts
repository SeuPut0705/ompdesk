import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localHandlerFor } from "./index";
import { handlers } from "./session-dump";
import { type LocalCommandContext, LocalCommandError } from "./types";

const roots: string[] = [];

async function tmp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dump-handler-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** Stock's archive as `session_dump` leaves it: a real zip in a temp folder. */
async function stockArchive(name: string, members: Record<string, string | Uint8Array>) {
	const zip = new JSZip();
	for (const [member, content] of Object.entries(members)) zip.file(member, content);
	const file = path.join(await tmp(), name);
	await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
	return { path: file, files: Object.keys(members), subagentCount: 0, anonymized: false };
}

/** A context whose bridge answers `session_dump` with `answer` and records what was asked. */
function fakeCtx(answer: unknown) {
	const request = vi.fn(async (_method: string, _params?: unknown) => answer);
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.12.2", run: vi.fn() },
		send: vi.fn(async () => {
			throw new Error("stock RPC must not be asked: its /dump only prints the path");
		}),
		bridge: {
			request: request as LocalCommandContext["bridge"]["request"],
			onEvent: vi.fn(() => () => {}),
			connected: true,
		},
	};
	return { ctx, request };
}

const run = (type: string, fields: Record<string, unknown>, ctx: LocalCommandContext) => {
	const handler = handlers[type];
	if (!handler) throw new Error(`no handler ${type}`);
	return handler({ type, ...fields }, ctx);
};

describe("dump_session_archive", () => {
	it("is served locally, never forwarded to stock", () => {
		expect(localHandlerFor("dump_session_archive")).toBe(handlers.dump_session_archive);
		expect(localHandlerFor("discard_session_archive")).toBe(handlers.discard_session_archive);
	});

	it("asks the bridge for stock's `/dump all` unless anonymized is true", async () => {
		const { ctx, request } = fakeCtx(null);
		request.mockImplementation(async () => stockArchive("omp-dump-1.zip", { "session.md": "# t\n" }));
		await run("dump_session_archive", {}, ctx);
		await run("dump_session_archive", { anonymized: true }, ctx);
		expect(request.mock.calls).toEqual([
			["session_dump", { anonymized: false }],
			["session_dump", { anonymized: true }],
		]);
		expect(ctx.send).not.toHaveBeenCalled();
	});

	it("answers a redacted copy of stock's archive, drops what is not text, and deletes stock's file", async () => {
		const stock = await stockArchive("omp-dump-2.zip", {
			"session.md": "mail jane.doe@example.com from /Users/janedoe/x\n",
			"subagents/A/B.md": "key sk-proj-0123456789abcdefABCDEF\n",
			"blob.bin": new Uint8Array([0xff, 0x00, 0xfe]),
		});
		const { ctx } = fakeCtx({ ...stock, subagentCount: 1, subagentError: "one unreadable" });

		const answer = await run("dump_session_archive", {}, ctx);

		expect(answer).toEqual({
			path: expect.stringMatching(/ompdesk-dump-[\w-]+\.zip$/),
			files: ["session.md", "subagents/A/B.md"],
			subagentCount: 1,
			anonymized: false,
			redacted: true,
			dropped: ["blob.bin"],
			subagentError: "one unreadable",
		});
		const { path: file } = answer as { path: string };
		const zip = await JSZip.loadAsync(await fs.readFile(file));
		expect(await zip.files["session.md"]?.async("string")).toBe("mail <email> from ~/x\n");
		expect(await zip.files["subagents/A/B.md"]?.async("string")).toBe("key <token>\n");
		expect(zip.files["blob.bin"]).toBeUndefined();
		await expect(fs.access(stock.path)).rejects.toThrow();
		await fs.rm(file);
	});

	it("deletes stock's archive even when it cannot be read", async () => {
		const file = path.join(await tmp(), "omp-dump-3.zip");
		await fs.writeFile(file, "not a zip");
		const { ctx } = fakeCtx({ path: file, files: ["session.md"], subagentCount: 0, anonymized: false });
		await expect(run("dump_session_archive", {}, ctx)).rejects.toThrow();
		await expect(fs.access(file)).rejects.toThrow();
	});

	it("fails with the no_messages code while the session has nothing to dump", async () => {
		const { ctx } = fakeCtx(null);
		const failure = await run("dump_session_archive", {}, ctx).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LocalCommandError);
		expect(failure).toMatchObject({ code: "no_messages" });
	});
});

describe("discard_session_archive", () => {
	it("deletes an archive this process produced, once", async () => {
		const { ctx } = fakeCtx(await stockArchive("omp-dump-4.zip", { "session.md": "# t\n" }));
		const { path: file } = (await run("dump_session_archive", {}, ctx)) as { path: string };

		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: true });
		await expect(fs.access(file)).rejects.toThrow();
		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: false });
	});

	it("never deletes a file it did not produce, whoever asks (a paired device reaches it over the tab RPC path)", async () => {
		const file = path.join(await tmp(), "precious.txt");
		await fs.writeFile(file, "keep me");
		const { ctx } = fakeCtx(null);
		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: false });
		await expect(fs.readFile(file, "utf8")).resolves.toBe("keep me");
	});
});
