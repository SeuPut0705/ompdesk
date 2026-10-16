/**
 * What a paired web device needs of this computer that Electron's windows do with native dialogs and the
 * shell (design §2.4): browse the host's disk, save a file onto it, open or reveal something on its screen,
 * and fetch a host file over `/blob`. Each is a web-only channel (shared/web-host.ts) with its permission:
 * `workspace` for the disk and blobs, `desktop-control` for what happens on the host's screen.
 */
import { constants, type Dirent, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { codedError } from "../../shared/ipc-error-codes";
import {
	WEB_HOST_CHANNELS,
	WEB_HOST_LIST_MAX_ENTRIES,
	type WebBlobOpenResult,
	type WebHostEntry,
	type WebHostListing,
	type WebHostOpenResult,
	type WebHostSaveResult,
} from "../../shared/web-host";
import { isOpenableExternalUrl } from "../external-url";
import { FS_BINARY_LOCAL_MAX_BYTES, resolveWithin, sniffMime } from "../workspace-fs";
import type { BlobStore } from "./blobs";
import type { WebDevices } from "./devices-store";
import type { UploadStore } from "./uploads";
import type { WebCallContext, WebChannelTable } from "./ws-router";

/** A device's own interface preferences: capped so a page cannot fill the devices file. */
export const DEVICE_UI_PREFS_MAX_BYTES = 64 * 1024;
/** Base64 a `SAVE` frame may carry (a frame is 1 MiB). */
const SAVE_INLINE_MAX_CHARS = 1_000_000;

export const WEB_DEVICE_CHANNELS = {
	/** → this device's own interface preferences (`Record<string, unknown>`). */
	UI_PREFS_GET: "web:device.uiPrefs.get",
	/** `prefs` replaces them. */
	UI_PREFS_SET: "web:device.uiPrefs.set",
} as const;

export interface HostActionsDeps {
	devices: Pick<WebDevices, "setUiPrefs">;
	uploads: Pick<UploadStore, "owns">;
	blobs: Pick<BlobStore, "addFile" | "release">;
	/** The folder a tab works in on this computer, for a relative path; null when unknown. */
	cwdFor(context: WebCallContext, tabId: string | undefined): string | null;
	/** The host's own "open" for a file (launcher types are revealed instead: main/open-path.ts). */
	openPath(abs: string): Promise<unknown>;
	reveal(abs: string): void;
	openExternal(url: string): Promise<void>;
	homedir?: () => string;
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true });

const ListRequest = z
	.object({
		path: z.string().max(4096).optional(),
		query: z.string().max(255).optional(),
		files: z.boolean().optional(),
	})
	.default({});
const PathRequest = z.object({ path: z.string().min(1).max(4096) });
const UrlRequest = z.object({ url: z.string().min(1).max(8192) });
const SaveRequest = z.object({
	dir: z.string().min(1).max(4096),
	name: z.string().min(1).max(255),
	data: z.string().max(SAVE_INLINE_MAX_CHARS).optional(),
	uploadPath: z.string().max(4096).optional(),
	overwrite: z.boolean().optional(),
});
const BlobRequest = z.object({
	path: z.string().min(1).max(4096),
	tabId: z.string().max(128).optional(),
	download: z.boolean().optional(),
});
const BlobUrl = z.union([z.string().min(1).max(512), z.object({ url: z.string().min(1).max(512) })]);

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
	const result = schema.safeParse(value);
	if (!result.success) throw codedError("invalid_content", "Invalid request");
	return result.data;
}

/** One path segment a user typed: no separators, no `.`/`..`, no control characters. */
function validName(name: string): boolean {
	return name.trim() === name && name !== "." && name !== ".." && !/[\\/]|\p{Cc}/u.test(name);
}

function expandHome(target: string, home: string): string {
	return target === "~" ? home : target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
}

export function createHostActions(deps: HostActionsDeps): WebChannelTable {
	const home = deps.homedir ?? os.homedir;

	const absoluteExisting = async (raw: string): Promise<string> => {
		const abs = expandHome(raw, home());
		if (!path.isAbsolute(abs)) throw codedError("not_absolute_path", "Not an absolute path");
		try {
			await fsp.access(abs);
		} catch {
			throw codedError("file_not_found", "File not found");
		}
		return path.normalize(abs);
	};

	const listDirs = async (_context: WebCallContext, args: readonly unknown[]): Promise<WebHostListing> => {
		const request = parse(ListRequest, args[0]);
		const homeDir = home();
		const dir = request.path === undefined || request.path === "" ? homeDir : expandHome(request.path, homeDir);
		if (!path.isAbsolute(dir)) throw codedError("not_absolute_path", "Not an absolute path");
		const abs = path.resolve(dir);
		let dirents: Dirent[];
		try {
			dirents = await fsp.readdir(abs, { withFileTypes: true });
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code === "ENOTDIR") throw codedError("not_a_directory", "Not a directory");
			if (code === "ENOENT") throw codedError("file_not_found", "Directory not found");
			throw error;
		}
		const needle = request.query?.trim().toLocaleLowerCase() ?? "";
		const found: WebHostEntry[] = [];
		for (const dirent of dirents) {
			if (dirent.name.startsWith(".")) continue;
			if (needle !== "" && !dirent.name.toLocaleLowerCase().includes(needle)) continue;
			const full = path.join(abs, dirent.name);
			let directory = dirent.isDirectory();
			let size: number | null = null;
			if (dirent.isSymbolicLink() || dirent.isFile()) {
				const info = await fsp.stat(full).catch(() => null);
				if (!info) continue;
				directory = info.isDirectory();
				size = directory ? null : info.size;
			}
			if (!directory && request.files !== true) continue;
			if (!directory && !dirent.isFile() && !dirent.isSymbolicLink()) continue;
			found.push({ name: dirent.name, path: full, directory, size });
		}
		found.sort((a, b) => Number(b.directory) - Number(a.directory) || NAME_ORDER.compare(a.name, b.name));
		const parent = path.dirname(abs);
		return {
			path: abs,
			parent: parent === abs ? null : parent,
			home: homeDir,
			entries: found.slice(0, WEB_HOST_LIST_MAX_ENTRIES),
			truncated: found.length > WEB_HOST_LIST_MAX_ENTRIES,
		};
	};

	const save = async (context: WebCallContext, args: readonly unknown[]): Promise<WebHostSaveResult> => {
		const request = parse(SaveRequest, args[0]);
		if (!validName(request.name)) return { ok: false, error: "Invalid file name", code: "invalid_name" };
		if ((request.data === undefined) === (request.uploadPath === undefined)) {
			return { ok: false, error: "Give either data or uploadPath", code: "invalid_content" };
		}
		const dir = expandHome(request.dir, home());
		if (!path.isAbsolute(dir)) return { ok: false, error: "Not an absolute path", code: "not_absolute_path" };
		const info = await fsp.stat(dir).catch(() => null);
		if (!info?.isDirectory()) return { ok: false, error: "Not a folder", code: "not_a_directory" };
		const target = path.join(path.resolve(dir), request.name);
		try {
			if (request.uploadPath !== undefined) {
				if (!deps.uploads.owns(context.deviceId, request.uploadPath)) {
					return { ok: false, error: "Not one of this device's uploads", code: "path_escapes_roots" };
				}
				await fsp.copyFile(request.uploadPath, target, request.overwrite ? 0 : constants.COPYFILE_EXCL);
			} else {
				await fsp.writeFile(target, Buffer.from(request.data ?? "", "base64"), {
					flag: request.overwrite ? "w" : "wx",
				});
			}
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code === "EEXIST") return { ok: false, error: "A file with that name exists", code: "exists" };
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, path: target };
	};

	const open = async (_context: WebCallContext, args: readonly unknown[]): Promise<WebHostOpenResult> => {
		const { path: target } = parse(PathRequest, args[0]);
		const abs = await absoluteExisting(target).catch((error: unknown) => error);
		if (typeof abs !== "string") return { ok: false, error: abs instanceof Error ? abs.message : String(abs) };
		await deps.openPath(abs);
		return { ok: true };
	};

	const reveal = async (_context: WebCallContext, args: readonly unknown[]): Promise<WebHostOpenResult> => {
		const { path: target } = parse(PathRequest, args[0]);
		const abs = await absoluteExisting(target).catch((error: unknown) => error);
		if (typeof abs !== "string") return { ok: false, error: abs instanceof Error ? abs.message : String(abs) };
		deps.reveal(abs);
		return { ok: true };
	};

	const openExternal = async (_context: WebCallContext, args: readonly unknown[]): Promise<void> => {
		const { url } = parse(UrlRequest, args[0]);
		if (isOpenableExternalUrl(url)) await deps.openExternal(url);
	};

	const blobOpen = async (context: WebCallContext, args: readonly unknown[]): Promise<WebBlobOpenResult> => {
		const request = parse(BlobRequest, args[0]);
		let abs = expandHome(request.path, home());
		if (!path.isAbsolute(abs)) {
			const root = deps.cwdFor(context, request.tabId);
			if (!root) return { ok: false, error: "No workspace", code: "no_workspace" };
			const within = resolveWithin(root, abs);
			if (!within) return { ok: false, error: "Path escapes the workspace", code: "path_escapes_workspace" };
			abs = within;
		}
		abs = path.normalize(abs);
		const info = await fsp.stat(abs).catch(() => null);
		if (!info?.isFile()) return { ok: false, error: "File not found", code: "file_not_found" };
		if (info.size > FS_BINARY_LOCAL_MAX_BYTES) return { ok: false, error: "File too large", code: "file_too_large" };
		const header = Buffer.alloc(Math.min(512, info.size));
		const handle = await fsp.open(abs, "r");
		try {
			await handle.read(header, 0, header.length, 0);
		} finally {
			await handle.close();
		}
		const mime = sniffMime(header, abs);
		const name = path.basename(abs);
		const url = deps.blobs.addFile(context.deviceId, { abs, mime, name, download: request.download === true });
		return { ok: true, url, mime, size: info.size, name };
	};

	const blobRelease = (context: WebCallContext, args: readonly unknown[]): void => {
		const given = parse(BlobUrl, args[0]);
		deps.blobs.release(context.deviceId, typeof given === "string" ? given : given.url);
	};

	return {
		[WEB_HOST_CHANNELS.LIST_DIRS]: { dir: "invoke", permission: "workspace", heavy: true, handler: listDirs },
		[WEB_HOST_CHANNELS.SAVE]: { dir: "invoke", permission: "workspace", handler: save },
		[WEB_HOST_CHANNELS.OPEN]: { dir: "invoke", permission: "desktop-control", handler: open },
		[WEB_HOST_CHANNELS.REVEAL]: { dir: "invoke", permission: "desktop-control", handler: reveal },
		[WEB_HOST_CHANNELS.OPEN_EXTERNAL]: { dir: "invoke", permission: "desktop-control", handler: openExternal },
		[WEB_HOST_CHANNELS.BLOB_OPEN]: { dir: "invoke", permission: "workspace", handler: blobOpen },
		[WEB_HOST_CHANNELS.BLOB_RELEASE]: { dir: "send", permission: "workspace", handler: blobRelease },
		[WEB_DEVICE_CHANNELS.UI_PREFS_GET]: {
			dir: "invoke",
			permission: "device-self",
			handler: context => context.device.uiPrefs,
		},
		[WEB_DEVICE_CHANNELS.UI_PREFS_SET]: {
			dir: "invoke",
			permission: "device-self",
			handler: (context, args) => {
				const prefs = parse(z.record(z.unknown()), args[0]);
				if (JSON.stringify(prefs).length > DEVICE_UI_PREFS_MAX_BYTES) {
					throw codedError("invalid_content", "Preferences are too large");
				}
				return deps.devices.setUiPrefs(context.deviceId, prefs);
			},
		},
	};
}
