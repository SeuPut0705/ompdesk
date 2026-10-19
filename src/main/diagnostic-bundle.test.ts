/**
 * "Save diagnostic bundle" end to end below Electron: the real local handlers (`dump_session_archive`,
 * `discard_session_archive`) answer a tab's RPC command, a fake bridge writes a real zip the way stock's
 * `dumpSessionArchiveToTmpDir` does, and the service copies it where the save dialog (or the agent) points with
 * OMPdesk's diagnostics text added. Files are real, in a temp directory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { DIAGNOSTICS_MEMBER, type DiagnosticBundleResult } from "../shared/diagnostic-bundle";
import type { IpcFsReadBinaryResult } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { type BundleTab, type DiagnosticBundleDeps, poolTabFor, saveDiagnosticBundle } from "./diagnostic-bundle";
import { runLocalCommand } from "./local";
import { handlers } from "./local/session-dump";
import type { LocalCommandContext } from "./local/types";
import type { ClientWindow } from "./web/client-window";
import type { IpcCaller } from "./web/ipc-registry";

const DIAGNOSTICS = "OMPdesk diagnostics\nversion 0.35.1\n";
const NOW = new Date(2026, 9, 19, 12, 0, 0);

const roots: string[] = [];

async function tmp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bundle-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	);

async function membersOf(file: string): Promise<Record<string, string>> {
	const zip = await JSZip.loadAsync(await fs.readFile(file));
	const members: Record<string, string> = {};
	for (const name of Object.keys(zip.files)) members[name] = await zip.files[name]!.async("string");
	return members;
}

type Members = Record<string, string | Uint8Array>;

/** A tab's omp: the local handlers over a bridge that writes stock's members (or `members`) into `dumpDir`. */
function fakeTab(options: { dumpDir: string; messages?: boolean; device?: string; members?: Members }) {
	const commands: RpcCommand[] = [];
	const asked: { anonymized: boolean }[] = [];
	const bridge: LocalCommandContext["bridge"] = {
		connected: true,
		onEvent: () => () => {},
		async request<T>(method: string, params?: unknown): Promise<T> {
			if (method !== "session_dump") throw new Error(`unexpected bridge method ${method}`);
			const anonymized =
				typeof params === "object" && params !== null && "anonymized" in params && params.anonymized === true;
			asked.push({ anonymized });
			if (options.messages === false) return null as T;
			const members: Members =
				options.members ??
				(anonymized
					? { "session.jsonl": '{"type":"session"}\n' }
					: { "session.md": "# transcript\n", "llm-request.json": "{}\n" });
			const zip = new JSZip();
			for (const [name, content] of Object.entries(members)) zip.file(name, content);
			const file = path.join(options.dumpDir, `omp-dump-${anonymized ? "anon-" : ""}${asked.length}.zip`);
			await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
			return { path: file, files: Object.keys(members), subagentCount: 0, anonymized } as T;
		},
	};
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.12.2", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async () => {
			throw new Error("stock RPC must not be asked");
		},
		bridge,
	};
	const tab: BundleTab = {
		tabId: "tab-1",
		sidecar: {
			cwd: "/repo",
			...(options.device ? { device: options.device } : {}),
			rpcClient: {
				command: async (command: RpcCommand): Promise<RpcResponse> => {
					commands.push(command);
					const handler = handlers[command.type];
					if (!handler) throw new Error(`no handler ${command.type}`);
					return runLocalCommand(handler, { ...command, id: "1" }, ctx);
				},
			},
		},
	};
	return { tab, commands, asked };
}

const caller = (browserWindow: boolean): IpcCaller => ({
	win: {} as ClientWindow,
	browserWindow: browserWindow ? ({} as BrowserWindow) : null,
	sender: { id: 1, once: () => undefined },
});

function setup(options: {
	dumpDir: string;
	messages?: boolean;
	device?: string;
	chosen?: string | null;
	members?: Members;
}) {
	const fake = fakeTab(options);
	const dialogs: string[] = [];
	const remoteReads: string[] = [];
	const deps: DiagnosticBundleDeps = {
		tabFor: (_caller, request) => (request.tabId === "tab-1" ? fake.tab : null),
		agentHidden: () => new Set(["/s/hidden.jsonl"]),
		diagnosticsText: async () => DIAGNOSTICS,
		readHostFile: async (_tab, file): Promise<IpcFsReadBinaryResult> => {
			remoteReads.push(file);
			const data = await fs.readFile(file);
			return { ok: true, data, mime: "application/zip", size: data.length, truncated: false };
		},
		chooseFile: async (_caller, defaultPath) => {
			dialogs.push(defaultPath);
			return options.chosen ?? null;
		},
		downloadsDir: () => path.join(options.dumpDir, "Downloads"),
		now: () => NOW,
	};
	return { ...fake, deps, dialogs, remoteReads };
}

const ok = (result: DiagnosticBundleResult) => {
	if (!result.ok) throw new Error(`expected a saved bundle, got ${JSON.stringify(result)}`);
	return result;
};

describe("saving through the dialog", () => {
	it("writes stock's members plus ompdesk-diagnostics.txt where the person chose and deletes the temp archive", async () => {
		const root = await tmp();
		const target = path.join(root, "chosen.zip");
		const { deps, commands, dialogs } = setup({ dumpDir: root, chosen: target });

		const result = ok(
			await saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false, title: "Fix login" }),
		);

		expect(result.path).toBe(target);
		expect(result.files).toEqual(["session.md", "llm-request.json", DIAGNOSTICS_MEMBER]);
		expect(await membersOf(target)).toEqual({
			"session.md": "# transcript\n",
			"llm-request.json": "{}\n",
			[DIAGNOSTICS_MEMBER]: DIAGNOSTICS,
		});
		expect(dialogs).toEqual([path.join(root, "Downloads", "omp-dump-Fix-login-2026-10-19.zip")]);
		expect(commands.map(command => command.type)).toEqual(["dump_session_archive", "discard_session_archive"]);
		expect(await fs.readdir(root)).toEqual(["chosen.zip"]);
	});

	it("takes stock's `/dump anon` archive for the anonymized variant and names it -anon", async () => {
		const root = await tmp();
		const target = path.join(root, "anon.zip");
		const { deps, asked, dialogs } = setup({ dumpDir: root, chosen: target });

		const result = ok(await saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: true }));

		expect(asked).toEqual([{ anonymized: true }]);
		expect(result.anonymized).toBe(true);
		expect(Object.keys(await membersOf(target)).sort()).toEqual([DIAGNOSTICS_MEMBER, "session.jsonl"]);
		expect(dialogs).toEqual([path.join(root, "Downloads", "omp-dump-2026-10-19-anon.zip")]);
	});

	it("does nothing when the person cancels the dialog: no dump is made", async () => {
		const root = await tmp();
		const { deps, commands } = setup({ dumpDir: root, chosen: null });

		await expect(saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false })).resolves.toEqual({
			ok: false,
			cancelled: true,
		});
		expect(commands).toEqual([]);
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("refuses a caller with no window to show the dialog in (a paired page picks a path instead)", async () => {
		const root = await tmp();
		const { deps, commands } = setup({ dumpDir: root, chosen: path.join(root, "x.zip") });

		await expect(
			saveDiagnosticBundle(deps, caller(false), { tabId: "tab-1", anonymized: false }),
		).resolves.toMatchObject({ ok: false, code: "no_window" });
		expect(commands).toEqual([]);
	});
});

describe("a session with nothing to dump", () => {
	it("fails with no_messages, writes no file and leaves no temp archive", async () => {
		const root = await tmp();
		const target = path.join(root, "never.zip");
		const { deps } = setup({ dumpDir: root, messages: false, chosen: target });

		await expect(
			saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false }),
		).resolves.toMatchObject({ ok: false, code: "no_messages" });
		expect(await fs.readdir(root)).toEqual([]);
	});
});

describe("a failure after stock wrote the archive", () => {
	it("still deletes the temp archive", async () => {
		const root = await tmp();
		const { deps } = setup({ dumpDir: root, chosen: path.join(root, "x.zip") });
		deps.diagnosticsText = async () => {
			throw new Error("log unreadable");
		};

		await expect(
			saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false }),
		).resolves.toMatchObject({ ok: false, error: "log unreadable" });
		expect(await fs.readdir(root)).toEqual([]);
	});
});

describe("saving for an agent", () => {
	it("writes to the Downloads folder under the default name and never replaces a file there", async () => {
		const root = await tmp();
		const downloads = path.join(root, "Downloads");
		await fs.mkdir(downloads);
		await fs.writeFile(path.join(downloads, "omp-dump-2026-10-19-anon.zip"), "a person's file");
		const { deps, dialogs } = setup({ dumpDir: root });

		const result = ok(
			await saveDiagnosticBundle(deps, caller(false), {
				tabId: "tab-1",
				anonymized: true,
				destination: { kind: "downloads" },
				forAgent: true,
			}),
		);

		expect(result.path).toBe(path.join(downloads, "omp-dump-2026-10-19-anon (2).zip"));
		expect(await fs.readFile(path.join(downloads, "omp-dump-2026-10-19-anon.zip"), "utf8")).toBe("a person's file");
		expect(Object.keys(await membersOf(result.path))).toContain(DIAGNOSTICS_MEMBER);
		expect(dialogs).toEqual([]);
	});

	it("writes to the absolute path it was given, adding .zip", async () => {
		const root = await tmp();
		const { deps } = setup({ dumpDir: root });

		const result = ok(
			await saveDiagnosticBundle(deps, caller(false), {
				tabId: "tab-1",
				anonymized: true,
				destination: { kind: "path", path: path.join(root, "report") },
				forAgent: true,
			}),
		);

		expect(result.path).toBe(path.join(root, "report.zip"));
		expect(await exists(result.path)).toBe(true);
	});

	it("refuses a path that is not absolute", async () => {
		const root = await tmp();
		const { deps, commands } = setup({ dumpDir: root });

		await expect(
			saveDiagnosticBundle(deps, caller(false), {
				tabId: "tab-1",
				anonymized: true,
				destination: { kind: "path", path: "report.zip" },
			}),
		).resolves.toMatchObject({ ok: false, code: "not_absolute_path" });
		expect(commands).toEqual([]);
	});

	it("refuses a session the person hid from agents, before anything is dumped", async () => {
		const root = await tmp();
		const { deps, commands } = setup({ dumpDir: root });

		await expect(
			saveDiagnosticBundle(deps, caller(false), {
				sessionPath: "/s/hidden.jsonl",
				anonymized: true,
				destination: { kind: "downloads" },
				forAgent: true,
			}),
		).resolves.toMatchObject({ ok: false, code: "session_hidden" });
		expect(commands).toEqual([]);
	});
});

describe("naming the tab", () => {
	it("says so when the tab or the session is not open", async () => {
		const root = await tmp();
		const { deps } = setup({ dumpDir: root, chosen: path.join(root, "x.zip") });

		await expect(
			saveDiagnosticBundle(deps, caller(true), { tabId: "gone", anonymized: false }),
		).resolves.toMatchObject({
			ok: false,
			code: "unknown_tab",
		});
		await expect(
			saveDiagnosticBundle(deps, caller(true), { sessionPath: "/s/stored.jsonl", anonymized: false }),
		).resolves.toMatchObject({ ok: false, code: "session_not_open" });
	});

	it("rejects a request that names neither", async () => {
		const root = await tmp();
		const { deps } = setup({ dumpDir: root });
		await expect(saveDiagnosticBundle(deps, caller(true), { anonymized: false })).rejects.toThrow(/invalid_content/);
	});

	it("finds a tab by its id in the caller's window, else by the session file it runs", () => {
		const sidecar = { cwd: "/repo", rpcClient: null };
		const tabFor = poolTabFor({
			tabTarget: (_win: unknown, tabId: string) =>
				tabId === "t1" ? { tabId: "t1", sidecar, device: undefined, winId: 1 } : null,
			sessionOwner: (sessionPath: string, device?: string) =>
				sessionPath === "/s/open.jsonl" && device === "host-1" ? { tabId: "t2", winId: 1 } : null,
			sidecarOf: (tabId: string) => (tabId === "t2" ? { ...sidecar, device: "host-1" } : null),
		} as unknown as Parameters<typeof poolTabFor>[0]);

		expect(tabFor(caller(true), { tabId: "t1", anonymized: false })?.tabId).toBe("t1");
		expect(tabFor(caller(true), { tabId: "t9", anonymized: false })).toBeNull();
		expect(tabFor(caller(true), { sessionPath: "/s/open.jsonl", device: "host-1", anonymized: false })?.tabId).toBe(
			"t2",
		);
		expect(tabFor(caller(true), { sessionPath: "/s/open.jsonl", anonymized: false })).toBeNull();
	});
});

describe("a tab on a paired host", () => {
	it("dumps on the host, reads the bytes back over the host file route, writes here and has the host delete its archive", async () => {
		const root = await tmp();
		const target = path.join(root, "from-host.zip");
		const { deps, commands, remoteReads, dialogs } = setup({ dumpDir: root, device: "host-1", chosen: target });

		const result = ok(await saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false }));

		expect(Object.keys(await membersOf(target)).sort()).toEqual([
			"llm-request.json",
			DIAGNOSTICS_MEMBER,
			"session.md",
		]);
		expect(remoteReads).toEqual([expect.stringMatching(/ompdesk-dump-[\w-]+\.zip$/)]);
		expect(path.dirname(remoteReads[0] ?? "")).toBe(root);
		expect(commands.map(command => command.type)).toEqual(["dump_session_archive", "discard_session_archive"]);
		expect(result.path).toBe(target);
		expect(dialogs).toHaveLength(1);
		expect(await fs.readdir(root)).toEqual(["from-host.zip"]);
	});

	it("reports the host's refusal to send an archive past its cap, and still has the host delete it", async () => {
		const root = await tmp();
		const { deps, commands } = setup({ dumpDir: root, device: "host-1", chosen: path.join(root, "x.zip") });
		deps.readHostFile = async () => ({
			ok: false,
			data: new Uint8Array(0),
			mime: "application/octet-stream",
			size: 12_000_000,
			truncated: false,
			error: "File is 12000000 bytes, over the 11534336-byte cap",
			code: "file_too_large",
		});

		await expect(
			saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false }),
		).resolves.toMatchObject({ ok: false, code: "file_too_large" });
		expect(commands.map(command => command.type)).toEqual(["dump_session_archive", "discard_session_archive"]);
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("gets every member redacted by the host before it reads a byte, the binary one left out, both variants", async () => {
		const secrets = [
			`ghp_${"a1B2".repeat(9)}`,
			"sk-proj-0123456789abcdefABCDEF",
			"8f14e45fceea167a",
			"jane.doe@example.com",
			"100.101.102.103",
			"192.168.1.23",
			"/Users/janedoe",
			"hunter2-hunter2",
		];
		const line = `use ${secrets[0]} or ${secrets[1]}; Authorization: Bearer ${secrets[2]}; ${secrets[3]} at ${secrets[4]} / ${secrets[5]} in ${secrets[6]}/proj`;
		const members: Members = {
			"session.md": `# Session\n\n${line}\n`,
			"llm-request.json": `${JSON.stringify({ systemPrompt: line, provider: { apiKey: secrets[7] }, messages: [{ content: line }] }, null, 2)}\n`,
			"subagents/Probe/Helper.md": `# Subagent\n${line}\n`,
			"session.jsonl": `${JSON.stringify({ type: "message", text: line, password: secrets[7] })}\n`,
			"capture.bin": new Uint8Array([0xff, 0xfe, 0x00, 0x9c, ...Buffer.from(secrets[0] ?? "")]),
		};
		for (const anonymized of [false, true]) {
			const root = await tmp();
			const target = path.join(root, "bundle.zip");
			const { deps, remoteReads } = setup({ dumpDir: root, device: "host-1", chosen: target, members });
			deps.readHostFile = async (_tab, file) => {
				remoteReads.push(file);
				const data = await fs.readFile(file);
				// What crosses the link is already clean.
				for (const text of Object.values(await membersOf(file)))
					for (const secret of secrets) expect(text).not.toContain(secret);
				return { ok: true, data, mime: "application/zip", size: data.length, truncated: false };
			};

			const result = ok(await saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized }));

			const saved = await membersOf(target);
			expect(Object.keys(saved).sort()).toEqual(
				["llm-request.json", DIAGNOSTICS_MEMBER, "session.jsonl", "session.md", "subagents/Probe/Helper.md"].sort(),
			);
			for (const [name, text] of Object.entries(saved))
				for (const secret of secrets) expect(text, `${name} holds ${secret}`).not.toContain(secret);
			expect(JSON.parse(saved["llm-request.json"] ?? "")).toMatchObject({ provider: { apiKey: "<secret>" } });
			expect(JSON.parse(saved["session.jsonl"] ?? "")).toMatchObject({ type: "message", password: "<secret>" });
			expect(result.dropped).toEqual(["capture.bin"]);
			expect(result.files).not.toContain("capture.bin");
			expect(remoteReads).toHaveLength(1);
			expect(await fs.readdir(root)).toEqual(["bundle.zip"]);
		}
	});

	it("refuses an older host's unredacted archive without saving it, and still has the host delete it", async () => {
		const root = await tmp();
		const raw = path.join(root, "omp-dump-raw.zip");
		await fs.writeFile(raw, await new JSZip().file("session.md", "secret").generateAsync({ type: "nodebuffer" }));
		const commands: RpcCommand[] = [];
		const { deps, remoteReads } = setup({ dumpDir: root, device: "host-1", chosen: path.join(root, "x.zip") });
		deps.tabFor = () => ({
			tabId: "tab-1",
			sidecar: {
				cwd: "/repo",
				device: "host-1",
				rpcClient: {
					command: async (command: RpcCommand): Promise<RpcResponse> => {
						commands.push(command);
						if (command.type === "discard_session_archive") await fs.rm(raw);
						const data = { path: raw, files: ["session.md"], subagentCount: 0, anonymized: false };
						return { id: "1", type: "response", command: command.type, success: true, data };
					},
				},
			},
		});

		await expect(
			saveDiagnosticBundle(deps, caller(true), { tabId: "tab-1", anonymized: false }),
		).resolves.toMatchObject({ ok: false, code: "remote_protocol" });
		expect(remoteReads).toEqual([]);
		expect(commands.map(command => command.type)).toEqual(["dump_session_archive", "discard_session_archive"]);
		expect(await fs.readdir(root)).toEqual([]);
	});
});
