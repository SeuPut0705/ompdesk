import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in audits on the user's small model: stock's own continue paths really resume
// what a killed or offline OMPdesk left. A turn is cut off by SIGKILL (no quit hook, no exit
// record); the next launch on the same userData finds the marker, the bridge runs stock
// `restoreSession` (what `omp --restore` runs) and the turn finishes with its reply, or, for a
// turn blocked on a person, the cut-off ask/approval runs again and its card reopens. Offline,
// the omp child reaches the provider through a proxy port that is closed until the test opens
// a CONNECT proxy on it: the provider's real transport error must read as "waiting".
interface SessionLine {
	type?: string;
	message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
}

/** Every `.jsonl` under the agent dir's sessions, parsed. */
function sessionLines(agent: string): SessionLine[] {
	const lines: SessionLine[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) {
				for (const line of readFileSync(full, "utf8").split("\n")) {
					if (line) lines.push(JSON.parse(line) as SessionLine);
				}
			}
		}
	};
	try {
		walk(path.join(agent, "sessions"));
	} catch {
		return [];
	}
	return lines;
}

function assistantText(line: SessionLine): string {
	const content = line.message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.join("");
}

interface Marker {
	reason: string;
}

async function markers(desktop: string): Promise<Marker[]> {
	try {
		return JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8")) as Marker[];
	} catch {
		return [];
	}
}

async function writePrefs(desktop: string, project: string, extra: Record<string, unknown> = {}): Promise<void> {
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			lastProject: project,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
			...extra,
		}),
	);
}

async function launchReady(
	args: string[],
	env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({ args, env });
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 90_000 })
		.toMatchObject({ status: "ready" });
	return { app, page };
}

async function sigkill(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

function repliedWith(agent: string, word: string): boolean {
	return sessionLines(agent).some(
		line =>
			line.message?.role === "assistant" && line.message.stopReason === "stop" && assistantText(line).includes(word),
	);
}

/** On a failure: what the transcripts and the window show, attached to the report. */
async function diagnose(agent: string, page: Page | undefined): Promise<void> {
	const summary = sessionLines(agent)
		.filter(line => line.message?.role)
		.map(line => {
			const content = line.message?.content;
			const calls = Array.isArray(content)
				? content
						.filter(
							block =>
								typeof block === "object" && block !== null && "type" in block && block.type === "toolCall",
						)
						.map(block => ("name" in block ? String(block.name) : "?"))
				: [];
			const text = line.message?.role === "assistant" ? assistantText(line) : JSON.stringify(content);
			return `${line.message?.role} ${line.message?.stopReason ?? ""} ${line.message?.errorMessage ?? ""} [${calls.join(",")}] ${(text ?? "").slice(0, 300)}`;
		})
		.join("\n");
	await test.info().attach("transcript.txt", { body: summary, contentType: "text/plain" });
	if (page && !page.isClosed()) {
		await test
			.info()
			.attach("window.png", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" })
			.catch(() => undefined);
	}
}

/**
 * A turn blocked on a person when OMPdesk is killed: the marker says `asking`, the relaunch
 * re-runs the cut-off call through stock `restoreSession`, the same card comes back (no
 * "continuing" toast: nothing runs on its own), and answering it finishes the turn.
 */
async function killWhileAsking(options: {
	prompt: string;
	setup?: (page: Page) => Promise<void>;
	card: RegExp;
	answer: (page: Page) => Promise<void>;
	reply: string;
}): Promise<void> {
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	await writePrefs(desktop, project);
	const args = [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`];
	let current: ElectronApplication | undefined;
	let shown: Page | undefined;
	try {
		const first = await launchReady(args, env);
		current = first.app;
		shown = first.page;
		await options.setup?.(first.page);
		const input = first.page.locator(".omp-composer-input").first();
		await input.fill(options.prompt);
		await input.press("Enter");
		const card = first.page.locator(".omp-ask-dock [data-prompt-card]");
		await expect(card).toContainText(options.card, { timeout: 240_000 });
		await expect
			.poll(async () => (await markers(desktop)).map(marker => marker.reason), { timeout: 30_000 })
			.toEqual(["asking"]);

		await sigkill(first.app);
		current = undefined;
		shown = undefined;

		const second = await electron.launch({ args, env });
		current = second;
		const page2 = await second.firstWindow();
		shown = page2;
		const again = page2.locator(".omp-ask-dock [data-prompt-card]");
		await expect(again).toContainText(options.card, { timeout: 240_000 });
		await expect(page2.getByText(/Continuing \d+ interrupted task/)).toHaveCount(0);
		await page2.screenshot({ path: test.info().outputPath("reopened.png"), animations: "disabled" });
		await options.answer(page2);
		await expect(again).toHaveCount(0, { timeout: 30_000 });
		await expect.poll(() => repliedWith(agent, options.reply), { timeout: 400_000 }).toBe(true);
		await expect.poll(() => markers(desktop), { timeout: 30_000 }).toEqual([]);
		await page2.screenshot({ path: test.info().outputPath("answered.png"), animations: "disabled" });
	} catch (error) {
		await diagnose(agent, shown);
		throw error;
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

test("real omp: an ask open when OMPdesk is killed reopens on the next launch and its answer finishes the turn", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	await killWhileAsking({
		prompt:
			"Use the ask tool once to ask me the question 'Which color?' with exactly two options: red and blue. Do nothing else before I answer. After I answer, reply with exactly COLOR- followed by my answer in capitals.",
		card: /Which color/i,
		answer: async page => {
			const card = page.locator(".omp-ask-dock [data-prompt-card]");
			// Picking an option only selects it (a note or a custom answer may follow); Submit answers.
			await card
				.getByText(/^blue$/i)
				.first()
				.click();
			await card.getByRole("button", { name: "Submit", exact: true }).click();
		},
		reply: "COLOR-BLUE",
	});
});

test("real omp: an approval open when OMPdesk is killed reopens on the next launch and approving finishes the turn", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	await killWhileAsking({
		prompt: "Run the bash command `echo approved-$((40+2))` and then reply with exactly its output and nothing else.",
		setup: async page => {
			const response = await page.evaluate(() => window.omp.rpc.setSetting("tools.approvalMode", "always-ask"));
			expect(response.success).toBe(true);
		},
		card: /echo approved/,
		answer: async page => {
			await page
				.locator(".omp-ask-dock [data-prompt-card]")
				.getByRole("button", { name: /^Approve/ })
				.first()
				.click();
		},
		reply: "approved-42",
	});
});

/** A free loopback port, closed again: connections to it are refused until something listens. */
async function closedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	await new Promise<void>(resolve => server.close(() => resolve()));
	return address.port;
}

/** A minimal HTTP CONNECT proxy on `port`: what turns the "network" back on for the omp child. */
async function connectProxy(port: number): Promise<net.Server> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(client => {
		sockets.add(client);
		client.once("close", () => sockets.delete(client));
		client.once("data", head => {
			const match = /^CONNECT ([^\s:]+):(\d+) HTTP/.exec(head.toString("latin1"));
			if (!match?.[1] || !match[2]) {
				client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
				return;
			}
			const upstream = net.connect(Number(match[2]), match[1], () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				upstream.pipe(client);
				client.pipe(upstream);
			});
			sockets.add(upstream);
			upstream.once("close", () => sockets.delete(upstream));
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		});
	});
	server.on("close", () => {
		for (const socket of sockets) socket.destroy();
	});
	await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
	return server;
}

test("real omp: a provider request that cannot connect while offline waits and continues once the connection returns", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	const port = await closedPort();
	await writePrefs(desktop, project, { proxyUrl: `http://127.0.0.1:${port}` });
	const args = [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`];
	let app: ElectronApplication | undefined;
	let proxy: net.Server | undefined;
	let shown: Page | undefined;
	try {
		const launched = await launchReady(args, env);
		app = launched.app;
		const { page } = launched;
		shown = page;
		await page.evaluate(() => window.dispatchEvent(new Event("offline")));
		const input = page.locator("textarea").first();
		await input.fill("Reply with exactly the word OFFLINE-OK and nothing else.");
		await input.press("Enter");

		// Stock's first refused attempt takes tens of seconds; its auto-retry would run ten more.
		// The wait takes over at the first one: no retry toasts, no failure card, no failure toast.
		const wait = page.locator("[data-connection-wait]");
		await expect(wait).toBeVisible({ timeout: 180_000 });
		await expect.poll(async () => (await markers(desktop)).map(marker => marker.reason)).toEqual(["network"]);
		await expect(page.locator(".omp-message-error")).toHaveCount(0);
		await expect(page.getByText(/^Retry \d+\/\d+ in|Retry failed/)).toHaveCount(0);
		await page.screenshot({ path: test.info().outputPath("waiting.png"), animations: "disabled" });
		const failure = sessionLines(agent).findLast(line => line.message?.stopReason === "error");
		test.info().annotations.push({ type: "provider-error", description: failure?.message?.errorMessage ?? "" });

		proxy = await connectProxy(port);
		await page.evaluate(() => window.dispatchEvent(new Event("online")));
		await expect(wait).toHaveCount(0, { timeout: 30_000 });
		await expect.poll(() => repliedWith(agent, "OFFLINE-OK"), { timeout: 300_000 }).toBe(true);
		await expect.poll(() => markers(desktop), { timeout: 30_000 }).toEqual([]);
		// The failed attempt is history now, not the turn's outcome.
		await expect(page.locator(".omp-transcript-content").getByText("OFFLINE-OK")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".omp-message-error")).toHaveCount(0);
		await page.screenshot({ path: test.info().outputPath("continued.png"), animations: "disabled" });
	} catch (error) {
		await diagnose(agent, shown);
		throw error;
	} finally {
		if (app) await exitApp(app);
		if (proxy) await new Promise<void>(resolve => proxy?.close(() => resolve()));
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("real omp: a turn killed mid-run continues on the next launch through stock restoreSession", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			lastProject: project,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
		}),
	);
	const args = [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`];
	let current: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const first = await electron.launch({ args, env });
		current = first;
		const page = await first.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const input = page.locator("textarea").first();
		await input.fill(
			"Run the bash command `sleep 40` and wait for it. When it finishes, reply with exactly the word FINISHED-RESUME.",
		);
		await input.press("Enter");

		// The call is on disk, so the cut-off turn has a tool batch to run again.
		await expect
			.poll(
				() =>
					sessionLines(agent).some(
						line =>
							line.message?.role === "assistant" && JSON.stringify(line.message.content).includes("sleep 40"),
					),
				{ timeout: 180_000 },
			)
			.toBe(true);
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8")).length, {
				timeout: 30_000,
			})
			.toBe(1);

		const killedAt = Date.now();
		const child = first.process();
		const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		current = undefined;

		const second = await electron.launch({ args, env });
		current = second;
		const page2 = await second.firstWindow();
		await expect(page2.getByText("Continuing 1 interrupted task")).toBeVisible({ timeout: 60_000 });

		// Stock closed the cut-off call as "outcome unknown", ran it again and answered.
		await expect
			.poll(
				() =>
					sessionLines(agent).some(
						line =>
							line.message?.role === "assistant" &&
							line.message.stopReason === "stop" &&
							assistantText(line).includes("FINISHED-RESUME"),
					),
				{ timeout: 400_000 },
			)
			.toBe(true);
		expect(Date.now()).toBeGreaterThan(killedAt);
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8")), {
				timeout: 30_000,
			})
			.toEqual([]);
		// One conversation, one session: the relaunch answered in the killed turn's own session file.
		await expect(page2.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]")).toHaveCount(1);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
