/**
 * Shared pieces of the README media scenes (`scenes/*.scene.ts`): a deterministic profile on the fake omp (example
 * project, example names, no personal data), a launch of the built app (`out/`) at a fixed size and 2x pixel density,
 * and a screencast recorder. A scene writes `<OUT>/<name>/frames.json` plus its JPEG frames (an animation) or one
 * `<name>.png` (a still); `encode.ts` turns those into `docs/media`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureOmp } from "../../e2e/harness";

/** Where scenes write their raw frames; `encode.ts` reads from here. */
export const RAW_DIR = process.env.README_MEDIA_RAW ?? "/tmp/ompdesk-readme-media";
/** The scenes' working folders (profiles, fake omp, repositories); fixed so paths in a frame never vary. */
export const WORK_DIR = "/tmp/ompdesk-readme-work";
/** One shared pixel density: frames are captured at 2x and encoded at the width in `Scene.width`. */
export const DEVICE_SCALE = 2;

export type Theme = "light" | "dark";

export interface Profile {
	root: string;
	project: string;
	desktop: string;
	agent: string;
	/** `OMP_GUI_TEST_RECORD`: what the fake omp got. */
	record: string;
	env: Record<string, string | undefined>;
}

const GIT = ["-c", "user.name=Example Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false"];
export const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const PROJECT_FILES: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "acme-web", version: "1.4.0", private: true, scripts: { test: "bun test", dev: "vite" } }, null, 2)}\n`,
	"README.md": "# acme-web\n\nThe storefront for Acme.\n\n- Product pages\n- Cart and checkout\n- Settings\n",
	"src/app.ts": "import { settings } from './settings';\n\nexport function start() {\n  return settings.theme;\n}\n",
	"src/settings.ts": "export const settings = {\n  theme: 'light',\n  language: 'en',\n};\n",
	"src/cart.ts":
		"export function total(items: { price: number; qty: number }[]) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n",
	"notes/roadmap.md": "# Roadmap\n\n## Next\n\n1. Dark theme\n2. Faster checkout\n3. Saved addresses\n",
};

export interface ProfileOptions {
	name: string;
	language?: "en" | "ko";
	theme?: Theme;
	prefs?: Record<string, unknown>;
	env?: Record<string, string | undefined>;
}

/** A clean profile under `WORK_DIR/<name>`: the example repository `acme-web`, prefs, an empty omp agent dir. */
export async function makeProfile(options: ProfileOptions): Promise<Profile> {
	const root = path.join(WORK_DIR, options.name);
	await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	const project = path.join(root, "acme-web");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir, { recursive: true })));
	git(project, "init", "-q", "-b", "main");
	for (const [file, text] of Object.entries(PROJECT_FILES)) {
		await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true });
		await fs.writeFile(path.join(project, file), text);
	}
	await fs.writeFile(path.join(project, ".gitignore"), "node_modules\n");
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "Initial commit");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: options.language ?? "en",
			themeName: options.theme ?? "light",
			firstRunComplete: true,
			lastProject: project,
			batchNotifications: false,
			...(options.prefs ?? {}),
		}),
	);
	const record = path.join(root, "rpc.jsonl");
	return {
		root,
		project,
		desktop,
		agent,
		record,
		env: {
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_README_SCENE: "1",
			OMP_WORKTREE_DIR: path.join(root, "wt"),
			GIT_AUTHOR_NAME: "Example Dev",
			GIT_AUTHOR_EMAIL: "dev@example.com",
			GIT_COMMITTER_NAME: "Example Dev",
			GIT_COMMITTER_EMAIL: "dev@example.com",
			...(options.env ?? {}),
		},
	};
}

export interface Launched {
	app: ElectronApplication;
	page: Page;
}

/**
 * Launch the built app on `profile` with a content size of `width` x `height` CSS pixels at 2x density. `restore`
 * launches without a folder, so the app reopens the layout the last run saved (a relaunch). Resolves once the
 * first sidecar is ready unless `ready` is false (a relaunch's first seconds are part of the clip).
 */
export async function launch(
	profile: Profile,
	width: number,
	height: number,
	options: { restore?: boolean; ready?: boolean } = {},
): Promise<Launched> {
	profile.env.OMP_GUI_OMP ??= await fixtureOmp(profile.root);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		...process.env,
		PI_CODING_AGENT_DIR: profile.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile.root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		...profile.env,
	}))
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
	const app = await electron.launch({
		args: [
			path.resolve("out/main/index.js"),
			...(options.restore ? [] : [profile.project]),
			`--user-data-dir=${profile.desktop}`,
			`--force-device-scale-factor=${DEVICE_SCALE}`,
		],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
	await page.waitForFunction(() => window.omp?.rpc != null);
	if (options.ready !== false)
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
	return { app, page };
}

export async function cleanup(profile: Profile): Promise<void> {
	await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** The tab list of the window, as the renderer's own API reports it. */
export const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());

/** A `bash` line the fake omp reads as a fixture command (`fixture:<name>`), sent to `tabId` or the active tab. */
export async function fixture(page: Page, line: string, tabId?: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) =>
			id === undefined
				? window.omp.rpc.command({ type: "bash", command })
				: window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response.success, JSON.stringify(response)).toBe(true);
}

/** One op of the fake omp's `fixture flow` turn (`fixture:flow:<json>`): a call, its output and end, a steer, the reply. */
export async function flow(page: Page, op: Record<string, unknown>, tabId?: string): Promise<void> {
	await fixture(page, `fixture:flow:${JSON.stringify(op)}`, tabId);
}

/** Type `text` into the composer a few characters at a time, as a person would, and send it. */
export async function typePrompt(page: Page, text: string, send = true): Promise<void> {
	const input = page.locator("textarea").first();
	await input.click();
	await page.keyboard.type(text, { delay: 22 });
	if (send) {
		await page.waitForTimeout(350);
		await page.keyboard.press("Enter");
	}
}

/** A small caption pill at the bottom of the page, for the moments the app itself shows nothing (a quit, a relaunch). */
export async function caption(page: Page, text: string | null): Promise<void> {
	await page.evaluate(label => {
		document.getElementById("readme-caption")?.remove();
		if (label === null) return;
		const pill = document.createElement("div");
		pill.id = "readme-caption";
		pill.textContent = label;
		pill.setAttribute(
			"style",
			"position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:9px 18px;" +
				"border-radius:999px;background:rgba(24,24,27,.92);color:#fff;font:600 15px system-ui,-apple-system,sans-serif;" +
				"letter-spacing:.01em;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none",
		);
		document.body.append(pill);
	}, text);
}

export interface Frame {
	file: string;
	/** Milliseconds since the recording started. */
	t: number;
}

export interface SceneMeta {
	name: string;
	/** Encoded width in pixels (the README shows it at half of this). */
	width: number;
	/** The longest a frame stays on screen in the clip, in ms: dead time (a relaunch gap, a wait) is cut to this. */
	maxHold: number;
	/** How long the last frame holds before the loop restarts, in ms. */
	endHold: number;
	frames: Frame[];
	/** Largest file, in MB, the encoder may produce for this clip. */
	maxMB: number;
	fps: number;
}

/** A CDP screencast of one page at a time; `attach` again after a relaunch to keep one clip. */
export class Recorder {
	readonly dir: string;
	private frames: Frame[] = [];
	private started = 0;
	private writes: Promise<unknown>[] = [];
	private stopCurrent: (() => Promise<void>) | undefined;
	private index = 0;

	constructor(
		readonly name: string,
		private readonly options: {
			width: number;
			height: number;
			maxHold?: number;
			endHold?: number;
			maxMB?: number;
			fps?: number;
		},
	) {
		this.dir = path.join(RAW_DIR, name);
	}

	async reset(): Promise<void> {
		await fs.rm(this.dir, { recursive: true, force: true });
		await fs.mkdir(this.dir, { recursive: true });
		this.frames = [];
		this.index = 0;
		this.started = Date.now();
	}

	/** Start recording `page`; a previous attachment stops first. */
	async attach(page: Page): Promise<void> {
		await this.detach();
		const client = await page.context().newCDPSession(page);
		const onFrame = (event: { data: string; sessionId: number }) => {
			const t = Date.now() - this.started;
			const file = `${String(this.index++).padStart(5, "0")}.jpg`;
			this.frames.push({ file, t });
			this.writes.push(fs.writeFile(path.join(this.dir, file), Buffer.from(event.data, "base64")));
			client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
		};
		client.on("Page.screencastFrame", onFrame);
		await client.send("Page.startScreencast", {
			format: "jpeg",
			quality: 92,
			maxWidth: Math.round(this.options.width * DEVICE_SCALE),
			maxHeight: Math.round(this.options.height * DEVICE_SCALE),
			everyNthFrame: 1,
		});
		this.stopCurrent = async () => {
			client.off("Page.screencastFrame", onFrame);
			await client.send("Page.stopScreencast").catch(() => undefined);
			await client.detach().catch(() => undefined);
		};
	}

	async detach(): Promise<void> {
		await this.stopCurrent?.();
		this.stopCurrent = undefined;
	}

	/** Stop and write `frames.json`. */
	async finish(extra: { width: number }): Promise<void> {
		await this.detach();
		await Promise.all(this.writes);
		const meta: SceneMeta = {
			name: this.name,
			width: extra.width,
			maxHold: this.options.maxHold ?? 1_200,
			endHold: this.options.endHold ?? 1_800,
			maxMB: this.options.maxMB ?? 3,
			fps: this.options.fps ?? 12,
			frames: this.frames,
		};
		await fs.writeFile(path.join(this.dir, "frames.json"), JSON.stringify(meta));
	}
}

/** A still at 2x: `<RAW_DIR>/<name>/<name>.png`, animations stopped. */
export async function still(page: Page, name: string, width = 1600): Promise<void> {
	const dir = path.join(RAW_DIR, name);
	await fs.rm(dir, { recursive: true, force: true });
	await fs.mkdir(dir, { recursive: true });
	await page.screenshot({ path: path.join(dir, `${name}.png`), animations: "disabled", scale: "device" });
	await fs.writeFile(path.join(dir, "still.json"), JSON.stringify({ name, width }));
}
