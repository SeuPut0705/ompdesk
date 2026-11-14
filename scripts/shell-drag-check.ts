/**
 * The title-bar drag check of the Rust shell, with the operating system's own pointer events, no person needed:
 *
 *   bun scripts/shell-drag-check.ts [--distance 120]
 *
 * It launches the staged shell (`resources/ompdesk-shell/<platform>-<arch>/`) on the built page (`bun run build`, the
 * fake omp of the e2e harness, a temp user-data folder), reads a point of the top bar's `-webkit-app-region: drag`
 * element (never a button or a link) from the page over CDP, then presses there, moves and releases the real pointer
 * (Windows `SetCursorPos`/`mouse_event` through `bun:ffi`; macOS `CGEventPost` through `scripts/shell-drag-check.swift`)
 * and asserts that the window moved by the drag distance and that the page saw no click.
 *
 * IT MOVES THE REAL POINTER AND A REAL WINDOW: it runs on GitHub runners (windows-latest, macos-15/26) and never on a
 * person's desktop. Without `CI=true` it refuses to start (`--i-know-this-moves-the-pointer` overrides, for a machine
 * that is not anyone's desktop).
 *
 * macOS: posting events needs the Accessibility grant (TCC). When the system refuses, the check says exactly that
 * (the helper's exit code 3 and its stderr) instead of failing the assertion.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fixtureOmp } from "../e2e/harness";
import { binaryName, stagedDir } from "./build-shell";

const REPO = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const distance = Number(args[args.indexOf("--distance") + 1]) || 120;

if (process.env.CI !== "true" && !args.includes("--i-know-this-moves-the-pointer")) {
	console.error("shell-drag-check moves the real pointer and a real window: it runs on CI only (CI=true).");
	process.exit(2);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A press at (x, y) in screen pixels, a move by (dx, dy) in steps, a release. */
async function drag(x: number, y: number, dx: number, dy: number): Promise<void> {
	if (process.platform === "win32") {
		// bun:ffi exists only where Bun does and is needed only on Windows here: a static import would break the macOS path.
		const { dlopen, FFIType } = await import("bun:ffi");
		const user32 = dlopen("user32.dll", {
			SetProcessDpiAwarenessContext: { args: [FFIType.ptr], returns: FFIType.i32 },
			SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			mouse_event: {
				args: [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64],
				returns: FFIType.void,
			},
		}).symbols;
		// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4: physical pixels, as the shell's window uses.
		user32.SetProcessDpiAwarenessContext(-4 as unknown as never);
		const LEFTDOWN = 0x0002;
		const LEFTUP = 0x0004;
		user32.SetCursorPos(Math.round(x), Math.round(y));
		await sleep(150);
		user32.mouse_event(LEFTDOWN, 0, 0, 0, 0n);
		// Small steps: Windows' move loop takes its grab point from the first move after the press, so one step is lost.
		const steps = 60;
		for (let step = 1; step <= steps; step++) {
			await sleep(8);
			user32.SetCursorPos(Math.round(x + (dx * step) / steps), Math.round(y + (dy * step) / steps));
		}
		await sleep(100);
		user32.mouse_event(LEFTUP, 0, 0, 0, 0n);
		return;
	}
	if (process.platform === "darwin") {
		const run = spawnSync(
			"swift",
			[path.join(REPO, "scripts", "shell-drag-check.swift"), String(x), String(y), String(dx), String(dy)],
			{
				encoding: "utf8",
			},
		);
		if (run.status === 3)
			throw new Error(
				`macOS refused to post pointer events (TCC Accessibility is not granted to this process): ${run.stderr.trim()}`,
			);
		if (run.status !== 0) throw new Error(`the drag helper failed (${run.status}): ${run.stderr.trim()}`);
		return;
	}
	throw new Error(`no pointer driver for ${process.platform}`);
}

interface Cdp {
	send(
		method: string,
		params?: object,
	): Promise<{ result?: { result?: { value?: unknown } }; error?: { message: string } }>;
	close(): void;
}

async function connect(port: number): Promise<Cdp> {
	const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
		type: string;
		url: string;
		webSocketDebuggerUrl: string;
	}>;
	const page = targets.find(t => t.type === "page" && t.url.startsWith("app://ompdesk/"));
	if (!page) throw new Error("the app page is not among the CDP targets");
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map<number, (message: never) => void>();
	let id = 0;
	socket.onmessage = event => {
		const message = JSON.parse(String(event.data)) as { id?: number };
		if (message.id !== undefined) pending.get(message.id)?.(message as never);
	};
	await new Promise<void>(resolve => {
		socket.onopen = () => resolve();
	});
	return {
		send: (method, params = {}) =>
			new Promise(resolve => {
				const mine = ++id;
				pending.set(mine, resolve as never);
				socket.send(JSON.stringify({ id: mine, method, params }));
			}),
		close: () => socket.close(),
	};
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
	const answer = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (answer.error) throw new Error(answer.error.message);
	return answer.result?.result?.value as T;
}

/** A point (CSS px, page coordinates) on a drag region that no control covers, found by scanning the drag elements. */
const FIND_POINT = `(() => {
	const region = el => { for (let n = el; n; n = n.parentElement) { const v = getComputedStyle(n).webkitAppRegion; if (v === 'no-drag') return false; if (v === 'drag') return true; } return false; };
	const control = el => el.closest('button,a,input,textarea,select,[role=button],[role=tab],[contenteditable]');
	const drags = [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).webkitAppRegion === 'drag');
	for (const el of drags.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)) {
		const r = el.getBoundingClientRect();
		if (r.width < 40 || r.height < 10) continue;
		for (let fy = 0.5; fy < 1; fy += 0.25) for (let fx = 0.1; fx < 0.9; fx += 0.05) {
			const x = r.left + r.width * fx, y = r.top + r.height * fy;
			const hit = document.elementFromPoint(x, y);
			if (hit && region(hit) && !control(hit)) return { x, y, tag: hit.tagName, dpr: devicePixelRatio, screenX: window.screenX, screenY: window.screenY };
		}
	}
	return null;
})()`;

async function main(): Promise<void> {
	const staged = stagedDir();
	// macOS runs the shell from its .app bundle (CEF finds its framework and helpers by that layout): the job assembles one
	// (scripts/package-mac.ts) and names its executable here.
	const exe = process.env.OMPDESK_SHELL_EXE || path.join(staged, binaryName());
	if (!fs.existsSync(exe)) throw new Error(`${exe} is missing: run bun run build:shell`);
	if (!fs.existsSync(path.join(REPO, "out", "main", "index.js")))
		throw new Error("out/ is missing: run bun run build");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-drag-"));
	const userData = path.join(root, "ud");
	const profile = path.join(root, "profile");
	const agent = path.join(root, "agent");
	const project = path.join(root, "project");
	for (const dir of [userData, profile, agent, project]) fs.mkdirSync(dir, { recursive: true });
	const child = spawn(exe, [project, `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
		env: {
			...process.env,
			OMPDESK_APP_DIR: REPO,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), profile),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(profile),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	// What the shell says is kept for a failure to start (a window-server-less runner, a missing library): it is also shown.
	let shellOutput = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream?.on("data", chunk => {
			process.stderr.write(chunk);
			shellOutput = (shellOutput + String(chunk)).slice(-4000);
		});
	}
	const startFailure = (what: string): Error => {
		const log = path.join(userData, "shell-webview", "shell.log.jsonl");
		const logged = fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-2000) : "(no shell.log.jsonl)";
		return new Error(
			`${what} (shell exit ${child.exitCode ?? "running"}, signal ${child.signalCode ?? "none"})\n--- shell output ---\n${shellOutput}\n--- shell.log.jsonl ---\n${logged}`,
		);
	};
	let cdp: Cdp | undefined;
	try {
		const portFile = path.join(userData, "shell-webview", "DevToolsActivePort");
		let port = 0;
		for (let i = 0; i < 300 && !port; i++) {
			await sleep(200);
			if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
		}
		if (!port) throw startFailure("the shell never wrote DevToolsActivePort");
		for (let i = 0; i < 150; i++) {
			try {
				cdp = await connect(port);
				break;
			} catch {
				await sleep(200);
			}
		}
		if (!cdp) throw new Error("no app page on the debugging port");
		await sleep(2500);
		await evaluate(
			cdp,
			"window.__dragClicks = 0; for (const t of ['click','mouseup','pointerup']) document.addEventListener(t, () => { window.__dragClicks++; }, true); true",
		);
		const found = await evaluate<{
			x: number;
			y: number;
			tag: string;
			dpr: number;
			screenX: number;
			screenY: number;
		} | null>(cdp, FIND_POINT);
		if (!found) throw new Error("no point of a -webkit-app-region: drag element is free of controls");
		console.log(`drag point: ${JSON.stringify(found)}`);
		// screenX/screenY and the point are in CSS px; the pointer works in the display's pixels on Windows, points on macOS.
		const scale = process.platform === "win32" ? found.dpr : 1;
		const startX = (found.screenX + found.x) * scale;
		const startY = (found.screenY + found.y) * scale;
		const dx = Math.round(distance * scale);
		const dy = Math.round((distance / 2) * scale);
		await drag(startX, startY, dx, dy);
		await sleep(500);
		const after = await evaluate<{ screenX: number; screenY: number; clicks: number }>(
			cdp,
			"({ screenX: window.screenX, screenY: window.screenY, clicks: window.__dragClicks })",
		);
		const movedX = after.screenX - found.screenX;
		const movedY = after.screenY - found.screenY;
		console.log(
			`window moved by (${movedX}, ${movedY}) CSS px; asked for (${distance}, ${distance / 2}); page saw ${after.clicks} click events`,
		);
		// The OS starts a title-bar move only after the pointer passed its drag threshold and takes the grab point from a
		// move after that, so a runner loses a few pixels (4 to 10 seen) that vary from run to run. What the check proves is
		// that the window follows the pointer and the page sees no click: a shortfall under a tenth of the distance is that.
		const slack = Math.max(12, distance / 10);
		const near = (actual: number, wanted: number) => Math.abs(actual - wanted) <= slack;
		if (!near(movedX, distance) || !near(movedY, distance / 2))
			throw new Error(
				`the window did not follow the drag: moved (${movedX}, ${movedY}), wanted (${distance}, ${distance / 2})`,
			);
		if (after.clicks !== 0) throw new Error(`the drag reached the page as ${after.clicks} click/mouseup events`);
		console.log("shell-drag-check: ok");
	} finally {
		cdp?.close();
		await stop(child);
		await removeTree(root);
	}
}

/** Ends the shell and, on Windows, the Node main it spawned (killing the shell alone leaves Node holding the profile). */
async function stop(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.pid === undefined) return;
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	if (process.platform === "win32")
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill();
	await Promise.race([exited, sleep(10_000)]);
}

/** Removes the temp profile, retrying while a dying process still holds a file; a leftover only warns: the drag result stands. */
async function removeTree(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 19)
				console.warn(
					`shell-drag-check: could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`,
				);
			else await sleep(500);
		}
	}
}

main().then(
	() => process.exit(0),
	error => {
		console.error(`shell-drag-check: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
