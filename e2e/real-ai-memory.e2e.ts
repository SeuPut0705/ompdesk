import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { ElectronApplication } from "playwright";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";
import { field, realOmpProfile, spentIn } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): the REAL ai-memory release binary and a REAL omp on the user's `smol` model
// (two short prompts), in a private HOME (the user's own ~/.omp, ~/.agents and ai-memory data are never read or
// written; credentials are copied into the private agent dir by `realOmpProfile`).
//
// What it proves, through the real extension and server: memory wires itself (ai-memory's own installer), a first
// omp session in a folder is captured and ends with an OPEN handoff, and the NEXT session in that folder gets that
// handoff injected at its first prompt (an `ai-memory-handoff` custom message in its own session file carrying the
// first session's text) and answers from it. A prompt typed with a fake secret never reaches the server's stored
// pages/observations verbatim.
//
// The real binary installs a per-user launchd service whose label is global to the logged-in user, so the test runs
// only when that label and port 49374 are free, and it always runs `uninstall --apply --yes` (with the private HOME)
// afterwards and checks the label is gone.
const LABEL = "com.github.akitaonrails.ai-memory";
const PORT = 49374;
const HANDOFF_TYPE = "ai-memory-handoff";
const SECRET_KEY = `sk-${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}`;
const SECRET_PASSWORD = "password=hunter2hunter2";
const REPORT = "/tmp/real-ai-memory.json";

function realBinary(): string | null {
	for (const candidate of [path.resolve("resources/ai-memory-bin/darwin-arm64/ai-memory"), "/tmp/aim/rel/ai-memory"]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function labelLoaded(): boolean {
	return spawnSync("launchctl", ["list", LABEL], { stdio: "ignore" }).status === 0;
}

function portBusy(): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect(PORT, "127.0.0.1");
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

interface SessionLine {
	[key: string]: unknown;
}

/** The parsed lines of the session file whose name carries `sessionId` (stock names it `<time>_<id>.jsonl`). */
async function sessionLines(agent: string, sessionId: string): Promise<SessionLine[]> {
	const root = path.join(agent, "sessions");
	const files = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
	const file = files.find(name => name.endsWith(".jsonl") && name.includes(sessionId));
	if (!file) return [];
	const text = await fs.readFile(path.join(root, file), "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as SessionLine);
}

/** Whether an assistant message of the session contains `needle`. */
function repliedWith(lines: SessionLine[], needle: string): boolean {
	return lines.some(line => {
		const message = field(line, "message");
		return field(message, "role") === "assistant" && JSON.stringify(field(message, "content")).includes(needle);
	});
}

async function sessionIdOf(page: Page, tabId: string): Promise<string> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tabId);
	const sessionId = field(response.data, "sessionId");
	if (typeof sessionId !== "string") throw new Error(`No session id for tab ${tabId}`);
	return sessionId;
}

/** Every file under `dir`, read whole (the wiki, the database, raw events): a secret may sit in any of them. */
async function dataFiles(dir: string): Promise<{ file: string; text: string }[]> {
	const names = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
	const out: { file: string; text: string }[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		if (!(await fs.stat(file).then(info => info.isFile(), () => false))) continue;
		out.push({ file: name, text: (await fs.readFile(file)).toString("latin1") });
	}
	return out;
}

test("real ai-memory: a session's capture becomes the next session's handoff in the same folder, secrets scrubbed", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit: set OMP_GUI_REAL_WORK=1");
	test.skip(process.platform !== "darwin", "The real-binary run drives macOS's launchd service");
	const bin = realBinary();
	test.skip(!bin, "No real ai-memory binary: run `bun run sync:ai-memory` or extract the release to /tmp/aim/rel/ai-memory");
	test.skip(labelLoaded(), `launchd label ${LABEL} is already loaded (the user's own ai-memory): not touching it`);
	test.skip(await portBusy(), `port ${PORT} is already in use (the user's own ai-memory server): not touching it`);
	if (!bin) return;
	test.setTimeout(900_000);

	const real = await realOmpProfile();
	const home = path.join(real.profile, "home");
	await fs.mkdir(home, { recursive: true });
	const omp = execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
	const env: Record<string, string | undefined> = {
		HOME: home,
		PI_CONFIG_DIR: path.relative(home, real.profile),
		OMP_GUI_OMP: omp,
		OMP_GUI_AI_MEMORY_BIN: bin,
		OMP_GUI_AI_MEMORY_NO_SERVICE: undefined,
		AI_MEMORY_DATA_DIR: undefined,
		PI_NO_TITLE: undefined,
	};
	const dataDir = path.join(home, "Library", "Application Support", "ai-memory");
	const uninstall = () =>
		spawnSync(bin, ["uninstall", "--apply", "--yes"], {
			env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: real.agent },
			encoding: "utf8",
			timeout: 120_000,
		});
	const report: Record<string, unknown> = { bin, smol: real.smol };
	interface Running {
		app: ElectronApplication;
		page: Page;
	}
	let current: Running | null = null;
	let keep = false;
	const win = (): Page => {
		if (!current) throw new Error("OMPdesk is not running");
		return current.page;
	};
	const launchReady = async (): Promise<void> => {
		const app = await launchApp({ project: real.project, desktop: real.desktop, agent: real.agent, profile: real.profile, env });
		const page = await app.firstWindow();
		current = { app, page };
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		// Wiring happens after the first tab booted; a session started now loads the generated extension.
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.aiMemory.getState())).phase, { timeout: 420_000 })
			.toBe("ready");
	};
	try {
		await launchReady();
		const ready = await win().evaluate(() => window.omp.aiMemory.getState());
		expect(ready).toMatchObject({ enabled: true, wiring: { extension: true, mcp: true } });
		expect(ready.dataDir).toBe(dataDir);
		expect(labelLoaded()).toBe(true);

		const tabs = () => win().evaluate(() => window.omp.tabs.list());
		const openTab = async (): Promise<string> => {
			const before = new Set((await tabs()).map(tab => tab.tabId));
			await expect(async () => {
				if ((await tabs()).length === before.size) await win().keyboard.press("ControlOrMeta+t");
				await expect.poll(async () => (await tabs()).length, { timeout: 3_000 }).toBe(before.size + 1);
			}).toPass({ timeout: 30_000 });
			const fresh = (await tabs()).find(tab => !before.has(tab.tabId));
			if (!fresh) throw new Error("No new tab");
			await expect.poll(async () => (await tabs()).find(tab => tab.tabId === fresh.tabId)?.status, { timeout: 90_000 }).toBe("ready");
			return fresh.tabId;
		};

		// Session 1: remember a codename, carry two fake secrets, answer PONG.
		const codename = `ZEPHYR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
		report.codename = codename;
		const first = await openTab();
		const firstId = await sessionIdOf(win(), first);
		const firstPrompt =
			`Remember this codename for later: ${codename}. ` +
			`(For your information only, do not repeat them: my key is ${SECRET_KEY} and ${SECRET_PASSWORD}.) ` +
			"Answer with exactly the word PONG.";
		await win().evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [first, firstPrompt] as const);
		await expect
			.poll(async () => repliedWith(await sessionLines(real.agent, firstId), "PONG"), { timeout: 240_000 })
			.toBe(true);

		// End it by closing its tab: main closes the omp's stdin first, which makes stock run its graceful teardown
		// (`session_shutdown`, which the extension turns into the `session-end` hook and the server into the handoff);
		// a bare SIGTERM would write no handoff.
		await win().evaluate(id => window.omp.tabs.close(id), first);
		const second = await openTab();
		const secondId = await sessionIdOf(win(), second);
		try {
			await expect
				.poll(
					async () => (await win().evaluate(() => window.omp.aiMemory.handoffs())).some(handoff => handoff.state === "open"),
					{ timeout: 120_000 },
				)
				.toBe(true);
		} catch (error) {
			// What the server holds when no handoff appeared: did the session reach it at all?
			report.diagnostic = await win().evaluate(async code => ({
				state: await window.omp.aiMemory.getState(),
				projects: await window.omp.aiMemory.projects().catch(String),
				handoffs: await window.omp.aiMemory.handoffs().catch(String),
				recent: await window.omp.aiMemory.recent().catch(String),
				search: await window.omp.aiMemory.search(code).catch(String),
			}), codename);
			throw error;
		}
		const handoffs = await win().evaluate(() => window.omp.aiMemory.handoffs());
		report.handoffs = handoffs.map(handoff => ({ state: handoff.state, agent: handoff.agent, summary: handoff.summary.slice(0, 200) }));

		// Session 2, the same folder: asked for the codename, it answers it from the handoff.
		await win().evaluate(
			([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }),
			[second, "What was the codename I asked you to remember earlier? Answer with only the codename."] as const,
		);
		await expect
			.poll(async () => repliedWith(await sessionLines(real.agent, secondId), codename), { timeout: 240_000 })
			.toBe(true);
		const secondLines = await sessionLines(real.agent, secondId);
		const injected = secondLines.filter(line => JSON.stringify(line).includes(HANDOFF_TYPE));
		report.injectedLines = injected.length;
		expect(injected.length).toBeGreaterThan(0);
		// Proof of the capture + handoff path through the real extension, not only the model's answer: the injected
		// custom message carries the first session's text.
		expect(injected.some(line => JSON.stringify(line).includes(codename))).toBe(true);
		const injectedMessage = injected.find(line => field(line, "customType") === HANDOFF_TYPE || field(field(line, "message"), "customType") === HANDOFF_TYPE);
		report.injectedType = injectedMessage ? "custom message" : "other line carrying the type";

		// The fake secrets: nothing stored may hold them verbatim (the whole data dir, and the server's own search).
		const files = await dataFiles(dataDir);
		report.dataFiles = files.length;
		const leaks = (needle: string) => files.filter(entry => entry.text.includes(needle)).map(entry => entry.file);
		const keyLeaks = leaks(SECRET_KEY);
		const passwordLeaks = leaks("hunter2hunter2");
		const searched = async (query: string) =>
			JSON.stringify(await win().evaluate(q => window.omp.aiMemory.search(q), query));
		const searchKey = (await searched(SECRET_KEY)).includes(SECRET_KEY);
		const searchPassword = (await searched("hunter2hunter2")).includes("hunter2hunter2");
		const stored = (await searched(codename)).includes(codename);
		report.scrubbed = {
			"sk- key": keyLeaks.length === 0 && !searchKey ? "scrubbed" : { files: keyLeaks, search: searchKey },
			"password=…": passwordLeaks.length === 0 && !searchPassword ? "scrubbed" : { files: passwordLeaks, search: searchPassword },
			codenameStoredAndSearchable: stored,
		};
		expect(keyLeaks, "the sk- key is stored verbatim").toEqual([]);
		expect(searchKey).toBe(false);
		expect(passwordLeaks, "the password= value is stored verbatim").toEqual([]);
		expect(searchPassword).toBe(false);
		report.spent = await spentIn(real.agent);
	} catch (error) {
		keep = true;
		throw error;
	} finally {
		try {
			const running = current as Running | null;
			if (running) {
				// Memory off through the app: the uninstall removes the service.
				await running.page.evaluate(() => window.omp.aiMemory.setEnabled(false)).catch(() => undefined);
				await expect
					.poll(async () => (await running.page.evaluate(() => window.omp.aiMemory.getState())).phase, { timeout: 120_000 })
					.toBe("off")
					.catch(() => undefined);
				await exitApp(running.app);
			}
		} finally {
			// Whatever happened above: ai-memory's own uninstall with the private HOME, then the label must be gone.
			const result = uninstall();
			report.uninstall = { status: result.status, tail: (result.stdout + result.stderr).trim().split("\n").slice(-3) };
			report.labelGone = !labelLoaded();
			await fs.writeFile(REPORT, JSON.stringify(report, null, 2)).catch(() => undefined);
			console.log(`real-ai-memory ${JSON.stringify(report)}`);
			if (keep) console.log(`real-ai-memory: profile kept for inspection: ${real.profile}`);
			else await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		expect(labelLoaded(), `launchd label ${LABEL} is still loaded`).toBe(false);
	}
});
