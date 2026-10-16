import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WEB_HOST_CHANNELS,
	type WebBlobOpenResult,
	type WebHostListing,
	type WebHostSaveResult,
} from "../../shared/web-host";
import { BlobStore } from "./blobs";
import type { WebDevice } from "./devices-store";
import { createHostActions, DEVICE_UI_PREFS_MAX_BYTES, WEB_DEVICE_CHANNELS } from "./host-actions";
import type { WebCallContext } from "./ws-router";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "web-host-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function rig(cwd: string | null = null) {
	const blobs = new BlobStore();
	const spies = {
		openPath: vi.fn(async () => {}),
		reveal: vi.fn(),
		openExternal: vi.fn(async () => {}),
		setUiPrefs: vi.fn(() => true),
	};
	const owned = new Set<string>();
	const table = createHostActions({
		devices: { setUiPrefs: spies.setUiPrefs },
		uploads: { owns: (_device, file) => owned.has(file) },
		blobs,
		cwdFor: () => cwd,
		openPath: spies.openPath,
		reveal: spies.reveal,
		openExternal: spies.openExternal,
		homedir: () => home,
	});
	const context = {
		deviceId: "dev1",
		device: { deviceId: "dev1", uiPrefs: { theme: "dark" } } as unknown as WebDevice,
		win: {} as WebCallContext["win"],
	} satisfies WebCallContext;
	const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
		const entry = table[channel];
		if (!entry) throw new Error(`no ${channel}`);
		return (await entry.handler(context, args)) as T;
	};
	return { table, call, blobs, owned, ...spies };
}

describe("web-only channels", () => {
	it("declare the permission each needs: disk and blobs workspace, the host's screen desktop-control", () => {
		const { table } = rig();
		const permissions = Object.fromEntries(
			Object.entries(table).map(([channel, entry]) => [channel, entry.permission]),
		);
		expect(permissions).toEqual({
			[WEB_HOST_CHANNELS.LIST_DIRS]: "workspace",
			[WEB_HOST_CHANNELS.SAVE]: "workspace",
			[WEB_HOST_CHANNELS.OPEN]: "desktop-control",
			[WEB_HOST_CHANNELS.REVEAL]: "desktop-control",
			[WEB_HOST_CHANNELS.OPEN_EXTERNAL]: "desktop-control",
			[WEB_HOST_CHANNELS.BLOB_OPEN]: "workspace",
			[WEB_HOST_CHANNELS.BLOB_RELEASE]: "workspace",
			[WEB_DEVICE_CHANNELS.UI_PREFS_GET]: "device-self",
			[WEB_DEVICE_CHANNELS.UI_PREFS_SET]: "device-self",
		});
		expect(table[WEB_HOST_CHANNELS.LIST_DIRS]?.heavy).toBe(true);
	});
});

describe("host disk browser", () => {
	it("lists the home folder's folders first, hides dotfiles, and names the parent", async () => {
		mkdirSync(join(home, "b-dir"));
		mkdirSync(join(home, "a-dir"));
		mkdirSync(join(home, ".hidden"));
		writeFileSync(join(home, "file.txt"), "hello");
		const { call } = rig();
		const folders = await call<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS);
		expect(folders).toMatchObject({ path: home, home, truncated: false });
		expect(folders.entries.map(entry => entry.name)).toEqual(["a-dir", "b-dir"]);
		const all = await call<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS, { files: true });
		expect(all.entries.map(entry => [entry.name, entry.directory, entry.size])).toEqual([
			["a-dir", true, null],
			["b-dir", true, null],
			["file.txt", false, 5],
		]);
		const sub = await call<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS, { path: join(home, "a-dir") });
		expect(sub.parent).toBe(home);
	});

	it("filters by name, follows symlinks to folders, and expands ~", async () => {
		mkdirSync(join(home, "Projects"));
		mkdirSync(join(home, "target"));
		symlinkSync(join(home, "target"), join(home, "link"));
		const { call } = rig();
		const found = await call<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS, { path: "~", query: "PROJ" });
		expect(found.entries.map(entry => entry.name)).toEqual(["Projects"]);
		const all = await call<WebHostListing>(WEB_HOST_CHANNELS.LIST_DIRS, { path: "~/" });
		expect(all.entries.map(entry => entry.name)).toEqual(["link", "Projects", "target"]);
	});

	it("fails with a code for a relative path, a file and a missing folder, and refuses a malformed request", async () => {
		writeFileSync(join(home, "f"), "x");
		const { call } = rig();
		await expect(call(WEB_HOST_CHANNELS.LIST_DIRS, { path: "relative" })).rejects.toThrow("[not_absolute_path]");
		await expect(call(WEB_HOST_CHANNELS.LIST_DIRS, { path: join(home, "f") })).rejects.toThrow("[not_a_directory]");
		await expect(call(WEB_HOST_CHANNELS.LIST_DIRS, { path: join(home, "nope") })).rejects.toThrow("[file_not_found]");
		await expect(call(WEB_HOST_CHANNELS.LIST_DIRS, { files: "yes" })).rejects.toThrow("[invalid_content]");
	});
});

describe("saving on the computer", () => {
	it("writes base64 data into a folder, refusing to replace a file unless asked", async () => {
		const { call } = rig();
		const data = Buffer.from("hello").toString("base64");
		const saved = await call<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, { dir: home, name: "a.txt", data });
		expect(saved).toEqual({ ok: true, path: join(home, "a.txt") });
		expect(readFileSync(join(home, "a.txt"), "utf8")).toBe("hello");
		const again = await call<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, { dir: home, name: "a.txt", data });
		expect(again).toMatchObject({ ok: false, code: "exists" });
		const over = await call<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, {
			dir: home,
			name: "a.txt",
			data: Buffer.from("new").toString("base64"),
			overwrite: true,
		});
		expect(over).toMatchObject({ ok: true });
		expect(readFileSync(join(home, "a.txt"), "utf8")).toBe("new");
	});

	it("copies one of the device's own uploads and refuses any other file", async () => {
		const upload = join(home, "uploaded.bin");
		const secret = join(home, "secret.txt");
		writeFileSync(upload, "bytes");
		writeFileSync(secret, "no");
		mkdirSync(join(home, "out"));
		const { call, owned } = rig();
		owned.add(upload);
		const copied = await call<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, {
			dir: join(home, "out"),
			name: "c.bin",
			uploadPath: upload,
		});
		expect(copied).toMatchObject({ ok: true });
		expect(readFileSync(join(home, "out", "c.bin"), "utf8")).toBe("bytes");
		const stolen = await call<WebHostSaveResult>(WEB_HOST_CHANNELS.SAVE, {
			dir: join(home, "out"),
			name: "s.txt",
			uploadPath: secret,
		});
		expect(stolen).toMatchObject({ ok: false, code: "path_escapes_roots" });
	});

	it("refuses a name with a path in it, both or neither source, a relative folder and a file as the folder", async () => {
		writeFileSync(join(home, "f"), "x");
		const { call } = rig();
		const data = "aGk=";
		for (const name of ["../x", "a/b", "a\\b", "..", ".", " pad", "ctl\u0001"]) {
			expect(await call(WEB_HOST_CHANNELS.SAVE, { dir: home, name, data }), name).toMatchObject({
				ok: false,
				code: "invalid_name",
			});
		}
		expect(await call(WEB_HOST_CHANNELS.SAVE, { dir: home, name: "x" })).toMatchObject({
			ok: false,
			code: "invalid_content",
		});
		expect(await call(WEB_HOST_CHANNELS.SAVE, { dir: home, name: "x", data, uploadPath: "/x" })).toMatchObject({
			ok: false,
		});
		expect(await call(WEB_HOST_CHANNELS.SAVE, { dir: "rel", name: "x", data })).toMatchObject({
			ok: false,
			code: "not_absolute_path",
		});
		expect(await call(WEB_HOST_CHANNELS.SAVE, { dir: join(home, "f"), name: "x", data })).toMatchObject({
			ok: false,
			code: "not_a_directory",
		});
	});
});

describe("the host's screen", () => {
	it("opens and reveals an existing absolute path, and reports a missing one", async () => {
		const file = join(home, "doc.pdf");
		writeFileSync(file, "x");
		const { call, openPath, reveal } = rig();
		expect(await call(WEB_HOST_CHANNELS.OPEN, { path: file })).toEqual({ ok: true });
		expect(openPath).toHaveBeenCalledWith(file);
		expect(await call(WEB_HOST_CHANNELS.REVEAL, { path: "~/doc.pdf" })).toEqual({ ok: true });
		expect(reveal).toHaveBeenCalledWith(file);
		expect(await call(WEB_HOST_CHANNELS.OPEN, { path: join(home, "gone") })).toMatchObject({ ok: false });
		await expect(call(WEB_HOST_CHANNELS.OPEN, { path: "relative.txt" })).resolves.toMatchObject({ ok: false });
		expect(openPath).toHaveBeenCalledTimes(1);
	});

	it("opens only web pages and mail drafts in the host's browser", async () => {
		const { call, openExternal } = rig();
		await call(WEB_HOST_CHANNELS.OPEN_EXTERNAL, { url: "https://example.com/a" });
		await call(WEB_HOST_CHANNELS.OPEN_EXTERNAL, { url: "file:///etc/passwd" });
		await call(WEB_HOST_CHANNELS.OPEN_EXTERNAL, { url: "javascript:alert(1)" });
		expect(openExternal.mock.calls).toEqual([["https://example.com/a"]]);
	});
});

describe("blob URLs for host files", () => {
	it("opens an absolute file, and one relative to the tab's folder, with a sniffed type", async () => {
		const project = join(home, "project");
		mkdirSync(project);
		writeFileSync(join(project, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
		const { call, blobs } = rig(project);
		const relative = await call<WebBlobOpenResult>(WEB_HOST_CHANNELS.BLOB_OPEN, { path: "pic.png" });
		expect(relative).toMatchObject({ ok: true, mime: "image/png", size: 10, name: "pic.png" });
		const absolute = await call<WebBlobOpenResult>(WEB_HOST_CHANNELS.BLOB_OPEN, {
			path: join(project, "pic.png"),
			download: true,
		});
		expect(absolute).toMatchObject({ ok: true });
		expect(blobs.size).toBe(2);
		if (relative.ok) {
			await call(WEB_HOST_CHANNELS.BLOB_RELEASE, relative.url);
			expect(blobs.release("dev1", relative.url)).toBe(false);
		}
	});

	it("refuses a relative path that escapes the folder, a missing file, a folder and a relative path with no tab", async () => {
		const project = join(home, "project");
		mkdirSync(project);
		const { call } = rig(project);
		expect(await call(WEB_HOST_CHANNELS.BLOB_OPEN, { path: "../secret" })).toMatchObject({
			ok: false,
			code: "path_escapes_workspace",
		});
		expect(await call(WEB_HOST_CHANNELS.BLOB_OPEN, { path: "none.txt" })).toMatchObject({
			ok: false,
			code: "file_not_found",
		});
		expect(await call(WEB_HOST_CHANNELS.BLOB_OPEN, { path: project })).toMatchObject({
			ok: false,
			code: "file_not_found",
		});
		const lone = rig(null);
		expect(await lone.call(WEB_HOST_CHANNELS.BLOB_OPEN, { path: "a.txt" })).toMatchObject({
			ok: false,
			code: "no_workspace",
		});
	});
});

describe("the device's own preferences", () => {
	it("reads them and stores a replacement, capped in size", async () => {
		const { call, setUiPrefs } = rig();
		expect(await call(WEB_DEVICE_CHANNELS.UI_PREFS_GET)).toEqual({ theme: "dark" });
		await call(WEB_DEVICE_CHANNELS.UI_PREFS_SET, { theme: "light" });
		expect(setUiPrefs).toHaveBeenCalledWith("dev1", { theme: "light" });
		await expect(
			call(WEB_DEVICE_CHANNELS.UI_PREFS_SET, { big: "x".repeat(DEVICE_UI_PREFS_MAX_BYTES) }),
		).rejects.toThrow("[invalid_content]");
		await expect(call(WEB_DEVICE_CHANNELS.UI_PREFS_SET, ["not", "a", "record"])).rejects.toThrow("[invalid_content]");
	});
});
