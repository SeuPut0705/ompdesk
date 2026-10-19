import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

	it("asks the bridge for stock's `/dump all` unless anonymized is true, and hands back its archive", async () => {
		const archive = { path: "/tmp/omp-dump-1.zip", files: ["session.md"], subagentCount: 0, anonymized: false };
		const { ctx, request } = fakeCtx(archive);
		await expect(run("dump_session_archive", {}, ctx)).resolves.toEqual(archive);
		await expect(run("dump_session_archive", { anonymized: true }, ctx)).resolves.toEqual(archive);
		expect(request.mock.calls).toEqual([
			["session_dump", { anonymized: false }],
			["session_dump", { anonymized: true }],
		]);
		expect(ctx.send).not.toHaveBeenCalled();
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
		const file = path.join(await tmp(), "omp-dump-2.zip");
		await fs.writeFile(file, "zip");
		const { ctx } = fakeCtx({ path: file, files: ["session.md"], subagentCount: 0, anonymized: false });
		await run("dump_session_archive", {}, ctx);

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
