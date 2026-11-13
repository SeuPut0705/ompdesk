/**
 * The deep-link area (`src/main/deep-link.ts`, `launch-argv.ts`'s `parseLaunchArgv`): what a launch's argv decodes to,
 * and what an `open-url`, an `open-file` and a `second-instance` do to a world of fake windows (which window is
 * spawned, shown and sent which link, when). Node's `path` rules the Rust side reproduces are captured as they are.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseLaunchArgv } from "../../../src/main/launch-argv";
import type { Step } from "../capture-chrome";
import { fakeShell } from "./fake-shell";

const URLS = [
	"omp://new",
	"omp://NEW",
	"omp://new/",
	"omp://new?x=1",
	"omp://session/abc",
	"omp://Session/abc",
	"omp://session/abc/",
	"omp://session//abc//",
	"omp://session/",
	"omp://session",
	"omp://session/a%20b",
	"omp://session/a/b",
	"omp://session/abc?x=1#y",
	"omp://session:99/abc",
	"omp://user@session/abc",
	"omp://session/../x",
	"omp://session/./abc",
	"omp://session/ab\tc",
	"omp://session/日本",
	"omp://session\\abc",
	"omp://sessi%6fn/x",
	"omp://foo",
	"omp:new",
	"omp:/new",
	"omp:///new",
	"http://new",
	"https://session/x",
	"OMP://New",
	" omp://new ",
	"not a url",
	"",
	"omp://[::1]/x",
	"omp://ses sion/x",
];

const FILES = [
	"/workspace/app",
	"/workspace/app/",
	"/workspace//app",
	"/workspace/./app",
	"/workspace/other/../app",
	"/workspace/app/..",
	"/",
	"//",
	"/workspace/new",
	"relative/dir",
	"./workspace/app",
	"",
	"~/workspace/app",
];

interface World {
	name: string;
	/** The cwd each live window shows, oldest first. */
	windows: Array<{ cwd: string; minimized?: boolean; loading?: boolean }>;
	/** Which window `getTargetWindow` answers (the focused one), or null. */
	target: number | null;
	/** Whether `getMainWindow` answers (the oldest window). */
	main: boolean;
}

const WORLDS: World[] = [
	{ name: "no window", windows: [], target: null, main: false },
	{ name: "one window", windows: [{ cwd: "/workspace/app" }], target: 0, main: true },
	{ name: "one loading window", windows: [{ cwd: "/workspace/app", loading: true }], target: 0, main: true },
	{
		name: "two windows, the second minimized and focused",
		windows: [{ cwd: "/workspace/other" }, { cwd: "/workspace/app", minimized: true }],
		target: 1,
		main: true,
	},
	{
		name: "two windows, none focused",
		windows: [{ cwd: "/workspace/x" }, { cwd: "/workspace/app" }],
		target: null,
		main: true,
	},
];

function directoryRules(): Step[] {
	const steps: Step[] = [];
	const directories = new Set(["/workspace/app", "/Applications/omp.app"]);
	const exists = (value: string) => directories.has(value);
	const argvs: string[][] = [
		["/Applications/omp.app", "omp://session/abc", "/workspace/app"],
		["electron-bin", "/workspace/app", "/nope"],
		["--class=App", "--no-sandbox", "/workspace/app"],
		["--flag", "./relative", "/missing"],
		["/tmp/not-a-directory"],
		[],
		["omp://new"],
		["OMP://new"],
		["xomp://new", "/workspace/app"],
		["-omp://new"],
		["/workspace/app", "omp://new"],
		["--", "/workspace/app"],
		["", "/workspace/app"],
		["omp:/new"],
		["/missing", "omp://session/first", "omp://new"],
	];
	for (const argv of argvs) {
		steps.push({
			fn: "src/main/launch-argv.ts#parseLaunchArgv",
			input: { argv, protocol: "omp", directories: [...directories] },
			output: parseLaunchArgv(argv, "omp", exists),
		});
	}
	return steps;
}

function nodePath(): Step[] {
	const steps: Step[] = [];
	const posix = [
		"/a",
		"/a/b/../c/",
		"//a//b",
		"/",
		"//",
		"/a/.",
		"/a/..",
		"/..",
		"/../a",
		"a/b",
		"./a",
		"",
		".",
		"..",
		"~/a",
		"/a b/ü",
	];
	for (const value of posix) {
		steps.push({
			fn: "node:path#posix.isAbsolute+resolve",
			input: { path: value },
			output: {
				absolute: path.posix.isAbsolute(value),
				resolved: path.posix.isAbsolute(value) ? path.posix.resolve(value) : null,
			},
		});
	}
	const win32 = [
		"C:\\a",
		"C:/a/../b",
		"c:/a/b/",
		"C:\\",
		"C:/",
		"C:",
		"C:a",
		"C:\\a\\.\\b",
		"C:\\a\\..\\..\\..",
		"\\\\srv\\share\\x\\..\\y",
		"\\\\srv\\share",
		"\\\\srv\\share\\",
		"//srv/share/x",
		"\\\\srv",
		"\\\\srv\\",
		"\\\\srv\\\\share\\x",
		"\\\\.\\C:\\x",
		"\\\\?\\C:\\a",
		"C:\\a b\\ü",
		"C:\\a\\\\b",
		"a\\b",
		"",
		"/",
		"\\",
		"/a",
		"\\a",
	];
	for (const value of win32) {
		const absolute = path.win32.isAbsolute(value);
		// A rooted path without a drive resolves against the process's drive: only the absolute flag is the contract.
		const rooted = /^[\\/](?![\\/])/.test(value);
		steps.push({
			fn: "node:path#win32.isAbsolute+resolve",
			input: { path: value },
			output: { absolute, resolved: absolute && !rooted ? path.win32.resolve(value) : null },
		});
	}
	return steps;
}

type Frameish = Record<string, unknown>;

interface FakeWindow {
	cwd: string;
	isMinimized(): boolean;
	restore(): void;
	show(): void;
	focus(): void;
	isDestroyed(): boolean;
	webContents: {
		isLoading(): boolean;
		once(event: string, fn: () => void): void;
		send(channel: string, payload: unknown): void;
	};
}

async function launches(): Promise<Step[]> {
	const steps: Step[] = [];
	const shell = await fakeShell({ platform: process.platform });
	// Static imports cannot work: `deep-link.ts` registers its `app` listeners while it loads, which needs the fake
	// shell above to be current first.
	const { setupDeepLinks } = await import("../../../src/main/deep-link");

	let world: World = WORLDS[0];
	let spawned: Array<string | null> = [];
	let calls: string[][] = [];
	let sent: Array<{ win: number | "spawned"; payload: unknown; when: "now" | "after-load" }> = [];
	let pendingLoads: Array<() => void> = [];
	let phase: "now" | "after-load" = "now";

	const makeWindow = (index: number | "spawned", cwd: string, minimized = false, loading = false): FakeWindow => {
		let isMinimized = minimized;
		const log = (name: string) => calls.push([String(index), name]);
		return {
			cwd,
			isMinimized: () => isMinimized,
			restore: () => {
				isMinimized = false;
				log("restore");
			},
			show: () => log("show"),
			focus: () => log("focus"),
			isDestroyed: () => false,
			webContents: {
				isLoading: () => loading,
				once: (_event: string, fn: () => void) => {
					pendingLoads.push(() => {
						loading = false;
						fn();
					});
				},
				send: (_channel: string, payload: unknown) => sent.push({ win: index, payload, when: phase }),
			},
		};
	};
	let windows: FakeWindow[] = [];
	const windowManager = {
		getMainWindow: () => (world.main ? windows[0] : null),
		getAllWindows: () => windows,
		getTargetWindow: () => (world.target === null ? null : windows[world.target]),
		recordFor: (win: { cwd: string }) => ({ cwd: win.cwd }),
	};
	const spawnWindow = (cwd?: string) => {
		spawned.push(cwd ?? null);
		return makeWindow("spawned", cwd ?? "");
	};
	setupDeepLinks(windowManager as never, spawnWindow as never);

	const run = async (event: string, data: Frameish, next: World): Promise<Frameish> => {
		world = next;
		spawned = [];
		calls = [];
		sent = [];
		pendingLoads = [];
		phase = "now";
		windows = next.windows.map((w, i) => makeWindow(i, w.cwd, w.minimized, w.loading));
		await shell.emit(event, data);
		phase = "after-load";
		for (const load of pendingLoads.splice(0)) load();
		const shown = [
			...new Set(
				calls.filter(([, name]) => name === "show").map(([win]) => (win === "spawned" ? win : Number(win))),
			),
		];
		return { spawned: [...spawned], shown, sent: [...sent], calls: [...calls] };
	};

	for (const next of WORLDS) {
		for (const url of URLS) {
			steps.push({
				fn: "src/main/deep-link.ts#open-url",
				input: { url, world: next },
				output: await run("app.openUrl", { url }, next),
			});
		}
		for (const file of FILES) {
			steps.push({
				fn: "src/main/deep-link.ts#open-file",
				input: { path: file, world: next },
				output: await run("app.openFile", { path: file }, next),
			});
		}
	}

	// Second launches: the argv a refused instance handed over. A real folder stands in for "an existing directory".
	const folder = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-deeplink-")));
	const exe = "/Applications/OMPdesk.app/Contents/MacOS/OMPdesk";
	const argvs: string[][] = [
		[exe],
		[exe, "omp://new"],
		[exe, "omp://session/abc"],
		[exe, "--flag", "omp://session/xyz", folder],
		[exe, "--flag"],
		[exe, folder],
		[exe, `${folder}/`],
		[exe, "./nowhere"],
		[exe, "relative"],
		[exe, "."],
		[exe, folder, "omp://new"],
		[folder],
		[],
	];
	// The real folder differs per machine: the file holds a placeholder the Rust replay fills with its own.
	const mask = <T>(value: T): T =>
		JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(folder).slice(1, -1), "<folder>"));
	for (const next of [
		WORLDS[0],
		WORLDS[1],
		{ ...WORLDS[3], windows: [{ cwd: "/workspace/other" }, { cwd: folder, minimized: true }] },
		{ ...WORLDS[4], windows: [{ cwd: "/workspace/x" }, { cwd: folder }] },
	]) {
		for (const argv of argvs) {
			steps.push({
				fn: "src/main/deep-link.ts#second-instance",
				input: mask({ argv, world: next }),
				output: mask(await run("app.secondInstance", { argv, cwd: "/" }, next)),
			});
		}
	}
	shell.close();
	return steps;
}

export async function capture(): Promise<Step[]> {
	return [...directoryRules(), ...nodePath(), ...(await launches())];
}
