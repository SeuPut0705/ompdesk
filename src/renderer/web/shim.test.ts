import { afterEach, describe, expect, it } from "vitest";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import type { OmpTransport } from "../../shared/omp-api";
import { PREVIEW_STREAM_PDF } from "../../shared/preview";
import type { WebChrome } from "./chrome";
import { LocalChannels } from "./deep-link";
import type { SaveOutcome } from "./download";
import { registerWebHostHooks } from "./host-hooks";
import type { FetchLike } from "./session";
import { createWebOmp, type ShimEnv } from "./shim";

const C = IPC_COMMANDS;
const E = IPC_EVENTS;

interface Call {
	channel: string;
	args: unknown[];
}

function setup(replies: Record<string, unknown> = {}, overrides: Partial<ShimEnv> = {}) {
	const invoked: Call[] = [];
	const sent: Call[] = [];
	const pushed = new Map<string, Set<(data: unknown) => void>>();
	const transport: OmpTransport = {
		invoke: <T>(channel: string, ...args: unknown[]) => {
			invoked.push({ channel, args });
			return Promise.resolve(replies[channel] as T);
		},
		send: (channel, ...args) => void sent.push({ channel, args }),
		on: (channel, listener) => {
			const set = pushed.get(channel) ?? new Set();
			set.add(listener);
			pushed.set(channel, set);
			return () => set.delete(listener);
		},
	};
	const log = {
		opened: [] as string[],
		confirms: [] as string[],
		prompts: [] as string[],
		saved: [] as { name: string; size: number; type: string }[],
		notified: [] as string[],
		errors: [] as string[],
		tray: [] as unknown[],
		colors: [] as unknown[],
		progress: [] as unknown[],
		tabs: [] as unknown[],
	};
	const answers = { confirm: true, prompt: null as string | null, pick: [] as File[], tabId: "t1" as string | null };
	const chrome = {
		applyTray: (state: unknown) => log.tray.push(state),
		applyColors: (colors: unknown) => log.colors.push(colors),
		applyProgress: (state: unknown) => log.progress.push(state),
	} as unknown as WebChrome;
	const channels = new LocalChannels();
	const fetches: { url: string; init?: RequestInit }[] = [];
	const fetchReply: { current: () => Response } = { current: () => new Response("{}", { status: 200 }) };
	const fetchFake: FetchLike = async (url, init) => {
		fetches.push({ url, init });
		return fetchReply.current();
	};
	let pending: string | null = "/sessions/a.jsonl";
	const web = createWebOmp({
		transport,
		fetch: fetchFake,
		chrome,
		channels,
		t: (key, params) => `${key}${params ? JSON.stringify(params) : ""}`,
		browser: {
			open: url => void log.opened.push(url),
			confirm: message => {
				log.confirms.push(message);
				return answers.confirm;
			},
			prompt: (message, initial) => {
				log.prompts.push(`${message}|${initial}`);
				return answers.prompt;
			},
		},
		openTab: async payload => {
			log.tabs.push(payload);
			return answers.tabId;
		},
		takePendingSessionPath: () => {
			const taken = pending;
			pending = null;
			return taken;
		},
		notify: (title, body) => void log.notified.push(`${title}|${body ?? ""}`),
		toastError: message => void log.errors.push(message),
		save: async (name, blob): Promise<SaveOutcome> => {
			log.saved.push({ name, size: blob.size, type: blob.type });
			return "downloaded";
		},
		pickFiles: async () => answers.pick,
		...overrides,
	});
	return { web, invoked, sent, pushed, log, answers, channels, fetches, fetchReply };
}

let unregister: (() => void) | null = null;
afterEach(() => {
	unregister?.();
	unregister = null;
});

const bytes = (text: string) => btoa(text);

describe("the web shim", () => {
	it("passes every call it does not own to the host unchanged", async () => {
		const { web, invoked, sent } = setup({ [C.SESSIONS_LIST]: [{ id: "s" }] });
		await expect(web.api.sessions.list("global")).resolves.toEqual([{ id: "s" }]);
		expect(invoked[0]).toEqual({ channel: C.SESSIONS_LIST, args: expect.anything() });
		web.api.runtime.startupMark("x" as never);
		expect(sent.at(-1)?.channel).toBe(C.RUNTIME_STARTUP_MARK);
	});

	describe("links", () => {
		it("opens an https link on the phone and never asks the host", async () => {
			const { web, log, invoked } = setup();
			await web.api.system.openExternal("https://example.com/a?b=1");
			expect(log.opened).toEqual(["https://example.com/a?b=1"]);
			expect(invoked).toEqual([]);
		});

		it("refuses a scheme that could run script", async () => {
			const { web, log } = setup();
			await expect(web.api.system.openExternal("javascript:alert(1)")).rejects.toThrow();
			await expect(web.api.system.openExternal("file:///etc/passwd")).rejects.toThrow();
			await expect(web.api.system.openExternal("not a url")).rejects.toThrow();
			expect(log.opened).toEqual([]);
		});

		it("routes an omp:// link on the page", async () => {
			const { web, channels } = setup();
			const seen: unknown[] = [];
			channels.on(E.DEEP_LINK, link => seen.push(link));
			await web.api.system.openExternal("omp://new");
			await web.api.system.openExternal("omp://session/abc-1");
			expect(seen).toEqual([{ action: "new-session" }, { action: "switch-session", sessionId: "abc-1" }]);
		});

		it("lets a registered hook (the view/open sheet) take the link, and 'Open on computer' reaches the host", async () => {
			const { web, invoked, log } = setup();
			unregister = registerWebHostHooks({
				openExternal: async url => {
					await web.host.openExternalOnComputer(url);
				},
			});
			await web.api.system.openExternal("https://example.com");
			expect(log.opened).toEqual([]);
			expect(invoked).toEqual([{ channel: C.SYSTEM_OPEN_EXTERNAL, args: ["https://example.com"] }]);
		});
	});

	describe("files the agent names", () => {
		it("downloads a file to the phone by default, reading it from the host", async () => {
			const { web, log, invoked } = setup({
				[C.FS_READ_BINARY]: { ok: true, mime: "text/plain", size: 5, truncated: false, dataBase64: bytes("hello") },
			});
			await expect(web.api.system.openPath("/work/notes.txt", "t1")).resolves.toEqual({ ok: true });
			expect(log.saved).toEqual([{ name: "notes.txt", size: 5, type: "text/plain" }]);
			expect(invoked[0]?.channel).toBe(C.FS_READ_BINARY);
		});

		it("reports a read failure with its code", async () => {
			const { web, log } = setup({
				[C.FS_READ_BINARY]: {
					ok: false,
					mime: "",
					size: 0,
					truncated: false,
					error: "gone",
					code: "file_not_found",
				},
			});
			await expect(web.api.system.openPath("/missing")).resolves.toEqual({
				ok: false,
				error: "gone",
				code: "file_not_found",
			});
			expect(log.saved).toEqual([]);
		});

		it("hands the host actions to a registered sheet", async () => {
			const { web, invoked } = setup({ [C.SYSTEM_OPEN_PATH]: { ok: true } });
			unregister = registerWebHostHooks({
				openPath: (path, tabId, host) => host.openPathOnComputer(path, tabId),
			});
			await expect(web.api.system.openPath("/a/b.pdf", "t9")).resolves.toEqual({ ok: true });
			expect(invoked).toEqual([{ channel: C.SYSTEM_OPEN_PATH, args: ["/a/b.pdf", "t9"] }]);
		});

		it("reveals on the computer unless a sheet takes it", async () => {
			const { web, invoked } = setup({ [C.SYSTEM_REVEAL_PATH]: { ok: true } });
			await web.api.system.revealPath("/a/b", "t1");
			expect(invoked).toEqual([{ channel: C.SYSTEM_REVEAL_PATH, args: ["/a/b", "t1"] }]);
		});

		it("turns a wire read into the Uint8Array the viewers expect (inline and by blob URL)", async () => {
			const inline = setup({
				[C.FS_READ_BINARY]: { ok: true, mime: "image/png", size: 3, truncated: false, dataBase64: bytes("abc") },
			});
			const small = await inline.web.api.fs.readBinary("/a.png", undefined, "t1");
			expect(Array.from(small.data)).toEqual([97, 98, 99]);

			const blob = setup({
				[C.FS_READ_BINARY]: { ok: true, mime: "video/mp4", size: 4, truncated: false, blobUrl: "/blob/tok?dl=0" },
			});
			blob.fetchReply.current = () => new Response(new Uint8Array([1, 2, 3, 4]));
			const big = await blob.web.api.fs.readBinary("/a.mp4");
			expect(Array.from(big.data)).toEqual([1, 2, 3, 4]);
			expect(blob.fetches[0]).toMatchObject({ url: "/blob/tok?dl=0" });
			expect(blob.fetches[0]?.init?.credentials).toBe("same-origin");
		});
	});

	describe("the preview's PDF", () => {
		it("prints on the computer and keeps the PDF on this device, answering the name it was kept as", async () => {
			const { web, invoked, log } = setup({
				[PREVIEW_STREAM_PDF]: { name: "page.pdf", base64: bytes("%PDF-1.7") },
			});
			await expect(web.api.preview.savePdf()).resolves.toBe("page.pdf");
			expect(invoked).toEqual([{ channel: PREVIEW_STREAM_PDF, args: [] }]);
			expect(log.saved).toEqual([{ name: "page.pdf", size: 8, type: "application/pdf" }]);
		});

		it("answers null when the person cancelled the save", async () => {
			const { web } = setup(
				{ [PREVIEW_STREAM_PDF]: { name: "page.pdf", base64: bytes("%PDF") } },
				{ save: async () => "cancelled" },
			);
			await expect(web.api.preview.savePdf()).resolves.toBeNull();
		});
	});

	describe("dialogs", () => {
		it("asks for a host path where a save dialog would open, and null when cancelled", async () => {
			const { web, log, answers } = setup();
			answers.prompt = "  /Users/me/out.png ";
			await expect(web.api.system.showSaveDialog("/Users/me/x.png")).resolves.toBe("/Users/me/out.png");
			expect(log.prompts[0]).toContain("/Users/me/x.png");
			answers.prompt = "   ";
			await expect(web.api.system.showSaveDialog()).resolves.toBeNull();
		});

		it("saves a diagnostic bundle where the computer's save sheet points: the host writes it, nothing lands on the phone", async () => {
			const saved = {
				ok: true,
				path: "/Users/me/out.zip",
				files: ["session.md"],
				subagentCount: 0,
				anonymized: false,
			};
			const { web, invoked, log } = setup({ [C.SESSIONS_DUMP_BUNDLE]: saved });
			const sheet: { defaultPath?: string; filters?: unknown } = {};
			unregister = registerWebHostHooks({
				showSaveDialog: async (defaultPath, filters) => {
					sheet.defaultPath = defaultPath;
					sheet.filters = filters;
					return "/Users/me/out.zip";
				},
			});

			await expect(
				web.api.sessions.saveDiagnosticBundle({ tabId: "t1", anonymized: true, title: "Fix login" }),
			).resolves.toEqual(saved);

			expect(sheet.defaultPath).toMatch(/^omp-dump-Fix-login-\d{4}-\d{2}-\d{2}-anon\.zip$/);
			expect(sheet.filters).toEqual([{ name: "Zip", extensions: ["zip"] }]);
			expect(invoked).toEqual([
				{
					channel: C.SESSIONS_DUMP_BUNDLE,
					args: [
						{
							tabId: "t1",
							anonymized: true,
							title: "Fix login",
							destination: { kind: "path", path: "/Users/me/out.zip" },
						},
					],
				},
			]);
			expect(log.saved).toEqual([]);
		});

		it("does not ask the host to dump when the sheet is cancelled", async () => {
			const { web, invoked } = setup();
			unregister = registerWebHostHooks({ showSaveDialog: async () => null });
			await expect(web.api.sessions.saveDiagnosticBundle({ tabId: "t1", anonymized: false })).resolves.toEqual({
				ok: false,
				cancelled: true,
			});
			expect(invoked).toEqual([]);
		});

		it("saves an image on the phone", async () => {
			const { web, log } = setup();
			await expect(web.api.system.saveImage("shot.png", "image/png", bytes("png!"))).resolves.toEqual({
				saved: true,
			});
			expect(log.saved).toEqual([{ name: "shot.png", size: 4, type: "image/png" }]);
		});

		it("uploads picked phone files for an open dialog and returns their host paths", async () => {
			const { web, answers, fetches, fetchReply } = setup();
			answers.pick = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
			let count = 0;
			fetchReply.current = () => new Response(JSON.stringify({ path: `/up/${++count}` }));
			await expect(web.api.system.showOpenDialog([{ name: "Text", extensions: ["txt"] }])).resolves.toEqual([
				"/up/1",
				"/up/2",
			]);
			expect(fetches.map(f => f.url)).toEqual(["/upload", "/upload"]);
		});

		it("returns null when no phone file was picked, and asks for a host folder when a directory is wanted", async () => {
			const { web, answers } = setup();
			await expect(web.api.system.showOpenDialog()).resolves.toBeNull();
			answers.prompt = "/Users/me/proj";
			await expect(web.api.system.showOpenDialog(undefined, { directory: true })).resolves.toEqual([
				"/Users/me/proj",
			]);
			await expect(web.api.sidecar.selectProject()).resolves.toBe("/Users/me/proj");
		});

		it("has no $EDITOR round trip of its own, and a sheet can provide one", async () => {
			const { web } = setup();
			await expect(web.api.editor.openExternal("draft")).resolves.toEqual({
				ok: false,
				unavailable: true,
				text: null,
			});
			unregister = registerWebHostHooks({
				openEditor: async content => ({ ok: true, unavailable: false, text: `${content}!` }),
			});
			await expect(web.api.editor.openExternal("draft")).resolves.toEqual({
				ok: true,
				unavailable: false,
				text: "draft!",
			});
		});
	});

	describe("uploads", () => {
		it("makes pathForFile an upload to /upload and remembers the answer for the same file", async () => {
			const { web, fetches, fetchReply } = setup();
			fetchReply.current = () => new Response(JSON.stringify({ path: "/up/report.pdf" }));
			const file = new File(["data"], "report.pdf", { type: "application/pdf" });
			await expect(web.api.fs.pathForFile(file)).resolves.toBe("/up/report.pdf");
			await expect(web.api.fs.pathForFile(file)).resolves.toBe("/up/report.pdf");
			expect(fetches).toHaveLength(1);
			const body = fetches[0]?.init?.body;
			expect(body).toBeInstanceOf(FormData);
			expect((body as FormData).get("file")).toBeInstanceOf(File);
			expect(fetches[0]?.init?.credentials).toBe("same-origin");
		});

		it("rejects with why when the host refuses, and tries again next time", async () => {
			const { web, log, fetchReply, fetches } = setup();
			fetchReply.current = () => new Response("{}", { status: 413 });
			const file = new File(["x"], "big.bin");
			await expect(web.api.fs.pathForFile(file)).rejects.toThrow('web.upload.refused{"name":"big.bin"}');
			// The composer says it; the shim does not toast it a second time.
			expect(log.errors).toEqual([]);
			fetchReply.current = () => new Response(JSON.stringify({ path: "/up/big.bin" }));
			await expect(web.api.fs.pathForFile(file)).resolves.toBe("/up/big.bin");
			expect(fetches).toHaveLength(2);
		});

		it("does not upload a file over 25 MB", async () => {
			const { web, fetches } = setup();
			const huge = new File(["x"], "huge.bin");
			Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
			await expect(web.api.fs.pathForFile(huge)).rejects.toThrow('web.upload.tooLarge{"name":"huge.bin"}');
			expect(fetches).toEqual([]);
		});

		it("says the network failed when the request throws", async () => {
			const { web, fetchReply } = setup();
			fetchReply.current = () => {
				throw new Error("offline");
			};
			await expect(web.api.fs.pathForFile(new File(["x"], "n.txt"))).rejects.toThrow(
				'web.upload.network{"name":"n.txt"}',
			);
		});

		it("uploads the phone files a host sheet picks, keeps the ones that landed and says why another did not", async () => {
			const { web, answers, log, fetches, fetchReply } = setup();
			answers.pick = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
			fetchReply.current = () => {
				const body = fetches.at(-1)?.init?.body as FormData;
				const name = (body.get("file") as File).name;
				return name === "a.txt"
					? new Response(JSON.stringify({ path: "/up/a.txt" }))
					: new Response("{}", { status: 500 });
			};
			await expect(web.host.pickPhoneFiles(undefined)).resolves.toEqual(["/up/a.txt"]);
			expect(log.errors).toEqual(['web.upload.refused{"name":"b.txt"}']);
		});

		it("sends a prompt's pictures by upload and the prompt names the host's copies (a frame holds 1 MB)", async () => {
			const { web, invoked, fetches, fetchReply } = setup();
			let answered = 0;
			fetchReply.current = () => new Response(JSON.stringify({ path: `/up/${++answered}/image.jpeg` }));
			const jpeg = { type: "image" as const, mimeType: "image/jpeg", data: bytes("JPEG bytes") };
			const png = { type: "image" as const, mimeType: "image/png", data: bytes("PNG") };
			await web.api.rpc.commandForTab("t1", { type: "prompt", message: "look", images: [jpeg, png] });
			expect(fetches.map(f => f.url)).toEqual(["/upload", "/upload"]);
			const sent = await Promise.all(
				fetches.map(async f => {
					const body = f.init?.body;
					if (!(body instanceof FormData)) throw new Error("not a form");
					const file = body.get("file");
					if (!(file instanceof File)) throw new Error("no file field");
					return { name: file.name, type: file.type, text: await file.text() };
				}),
			);
			expect(sent).toEqual([
				{ name: "image.jpeg", type: "image/jpeg", text: "JPEG bytes" },
				{ name: "image.png", type: "image/png", text: "PNG" },
			]);
			expect(invoked.at(-1)).toEqual({
				channel: C.RPC_COMMAND_FOR_TAB,
				args: [
					{
						tabId: "t1",
						command: {
							type: "prompt",
							message: "look",
							images: [
								{ type: "image", mimeType: "image/jpeg", upload: "/up/1/image.jpeg" },
								{ type: "image", mimeType: "image/png", upload: "/up/2/image.jpeg" },
							],
						},
					},
				],
			});
		});

		it("does not send a prompt whose picture the computer refused, and says why", async () => {
			const { web, invoked, fetchReply } = setup();
			fetchReply.current = () => new Response("{}", { status: 429 });
			const image = { type: "image" as const, mimeType: "image/jpeg", data: bytes("x") };
			await expect(
				web.api.rpc.commandForTab("t1", { type: "prompt", message: "look", images: [image] }),
			).rejects.toThrow("web.upload.imageRefused");
			expect(invoked).toEqual([]);
		});

		it("leaves a call without pictures as it is, uploading nothing", async () => {
			const { web, invoked, fetches } = setup();
			await web.api.rpc.commandForTab("t1", { type: "prompt", message: "plain" });
			expect(fetches).toEqual([]);
			expect(invoked.at(-1)?.args).toEqual([{ tabId: "t1", command: { type: "prompt", message: "plain" } }]);
		});
	});

	describe("notifications and chrome", () => {
		it("shows the page's notification instead of asking the host's OS", async () => {
			const { web, log, invoked } = setup();
			web.api.system.notify("Done", "Finished", "t1", "completion");
			await Promise.resolve();
			expect(log.notified).toEqual(["Done|Finished"]);
			expect(invoked).toEqual([]);
		});

		it("lets a hook claim the notification", async () => {
			const { web, log } = setup();
			unregister = registerWebHostHooks({ notify: () => true });
			web.api.system.notify("Done");
			await Promise.resolve();
			expect(log.notified).toEqual([]);
		});

		it("turns the tray, progress and window-color pushes into page chrome and sends nothing", () => {
			const { web, log, sent } = setup();
			web.api.tray.pushState({ status: "approval" } as never);
			web.api.progress.set("working");
			web.api.windowChrome.setColors({ color: "#111", symbolColor: "#fff" });
			expect(log.tray).toEqual([{ status: "approval" }]);
			expect(log.progress).toEqual(["working"]);
			expect(log.colors).toEqual([{ color: "#111", symbolColor: "#fff" }]);
			expect(sent).toEqual([]);
		});

		it("does not report the phone's connectivity to the host", () => {
			const { web, sent } = setup();
			web.api.resume.reportOnline(false);
			expect(sent).toEqual([]);
		});
	});

	describe("quit and update", () => {
		it("sends quit only after a confirmation", async () => {
			const { web, sent, answers, log } = setup();
			answers.confirm = false;
			web.api.app.quit();
			await Promise.resolve();
			expect(sent).toEqual([]);
			answers.confirm = true;
			web.api.app.quit();
			await Promise.resolve();
			await Promise.resolve();
			expect(sent).toEqual([{ channel: C.APP_QUIT, args: [] }]);
			expect(log.confirms).toHaveLength(2);
		});

		it("applies an update only after a confirmation", async () => {
			const { web, invoked, answers } = setup();
			answers.confirm = false;
			await web.api.updater.apply();
			expect(invoked.filter(call => call.channel === C.UPDATER_APPLY)).toEqual([]);
			answers.confirm = true;
			await web.api.updater.apply();
			expect(invoked.filter(call => call.channel === C.UPDATER_APPLY)).toHaveLength(1);
		});
	});

	describe("sessions and page-made channels", () => {
		it("opens 'in new window' as a new tab on this device", async () => {
			const { web, log, answers } = setup();
			await expect(web.api.sessions.openInNewWindow({ sessionPath: "/s.jsonl", cwd: "/p" })).resolves.toBe(true);
			expect(log.tabs).toEqual([{ sessionPath: "/s.jsonl", cwd: "/p", device: undefined }]);
			answers.tabId = null;
			await expect(web.api.sessions.openInNewWindow({ cwd: "/p" })).resolves.toBe(false);
		});

		it("hands out the session the page was opened for exactly once", async () => {
			const { web } = setup();
			await expect(web.api.sessions.consumePendingOpen()).resolves.toBe("/sessions/a.jsonl");
			await expect(web.api.sessions.consumePendingOpen()).resolves.toBeNull();
		});

		it("serves menu actions, deep links and notification clicks from the page, not the socket", () => {
			const { web, channels, pushed } = setup();
			const seen: unknown[] = [];
			web.api.events.onMenuAction((action, payload) => seen.push([action, payload?.cwd]));
			web.api.events.onDeepLink(link => seen.push(link));
			web.api.events.onNotificationClick(click => seen.push(click));
			web.emitMenuAction("new-session", { cwd: "/p" });
			channels.emit(E.DEEP_LINK, { action: "new-session" });
			channels.emit(E.NOTIFICATION_CLICK, { tabId: "t3" });
			expect(seen).toEqual([["new-session", "/p"], { action: "new-session" }, { tabId: "t3" }]);
			expect(pushed.has(E.MENU_ACTION)).toBe(false);
			expect(pushed.has(E.DEEP_LINK)).toBe(false);
			expect(pushed.has(E.NOTIFICATION_CLICK)).toBe(false);
		});

		it("subscribes host pushes on the socket", () => {
			const { web, pushed } = setup();
			web.api.prefs.onChanged(() => undefined);
			expect(pushed.has(E.PREFS_CHANGED)).toBe(true);
		});
	});
});
