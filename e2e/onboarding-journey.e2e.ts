import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";
import { baseTemp } from "./run-temp";
import { capturer, type Finding, resize } from "./shell-capture";

// Opt-in audit of the first-time journey on the real omp (OMP_GUI_ONBOARDING=<dir>):
// an empty agent dir (no provider), a signed-out gh, a local OpenAI-compatible
// endpoint whose first answer is one bash tool call and whose second is text.
// provider step (custom endpoint) → model → GitHub → first request → finished
// work card, at the window's minimum size, in light/dark × en/ko, the dark runs
// under reduced motion. Findings (overflow, clipped text, motion) land next to
// the captures.

const directory = process.env.OMP_GUI_ONBOARDING;
test.describe.configure({ mode: "parallel" });
test.skip(!directory, "set OMP_GUI_ONBOARDING=<dir> to capture the first-time journey");

const VARIANTS = [
	{ language: "en", theme: "light", reduced: false },
	{ language: "en", theme: "dark", reduced: true },
	{ language: "ko", theme: "light", reduced: true },
	{ language: "ko", theme: "dark", reduced: false },
] as const;

/** Streams one tool call for a request without a tool result, else a short text. */
function endpoint(): Promise<{ server: http.Server; port: number }> {
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", () => {
			if (!request.url?.includes("chat/completions")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ object: "list", data: [{ id: "audit-model", object: "model" }] }));
				return;
			}
			const hasToolResult = body.includes('"role":"tool"');
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "audit-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.write(chunk({ role: "assistant", content: "" }, null));
			if (hasToolResult) {
				response.write(chunk({ content: "I created hello.txt for you." }, null));
				response.write(chunk({}, "stop"));
			} else {
				response.write(
					chunk(
						{
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: {
										name: "bash",
										arguments: JSON.stringify({
											command: "echo hello > hello.txt && cat hello.txt",
											i: "Writing hello.txt",
										}),
									},
								},
							],
						},
						null,
					),
				);
				response.write(chunk({}, "tool_calls"));
			}
			response.write(
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "audit-model", choices: [], usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
	});
	const { promise, resolve } = Promise.withResolvers<{ server: http.Server; port: number }>();
	server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
	return promise;
}

for (const variant of VARIANTS) {
	test(`first run to first work card (${variant.language} ${variant.theme}${variant.reduced ? " reduced motion" : ""})`, async () => {
		test.setTimeout(240_000);
		const { language, theme, reduced } = variant;
		const { server, port } = await endpoint();
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-onboarding-")));
		const [project, desktop, agent, gh] = ["project", "desktop", "agent", "gh"].map(name => path.join(root, name));
		await Promise.all([project, desktop, agent, gh].map(dir => fs.mkdir(dir)));
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, launchProfiles: { [project]: { noRules: true, noLsp: true } } }),
		);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			GH_CONFIG_DIR: gh,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
		};
		Reflect.deleteProperty(env, "OMP_GUI_OMP");
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
			env: Object.fromEntries(
				Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
		});
		const findings: Finding[] = [];
		const notes: string[] = [];
		const errors: string[] = [];
		const prefix = `journey-${language}-${theme}`;
		const page: Page = await app.firstWindow();
		page.on("pageerror", error => errors.push(error.message));
		try {
			if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
			// The window's minimum size: the harshest layout a new user can have.
			await resize(app, 800, 600);
			const shoot = capturer(page, directory, `${prefix}-${test.info().repeatEachIndex}`, findings);
			await page.waitForFunction(() => window.omp?.rpc != null);
			// When the setup section mounts and unmounts: a step that is rebuilt under the user's hands shows up here.
			await page.evaluate(() => {
				const log: string[] = [];
				Reflect.set(window, "__setupLog", log);
				const start = performance.now();
				const mark = (what: string, nodes: NodeList) => {
					for (const node of nodes) {
						if (!(node instanceof Element)) continue;
						for (const selector of [
							"[data-first-run-step]",
							".omp-transcript-scroll",
							".omp-empty-canvas",
							"[data-testid=machine-setup]",
						]) {
							const hit = node.matches(selector) ? node : node.querySelector(selector);
							if (hit)
								log.push(
									`${Math.round(performance.now() - start)}ms ${what} ${selector} ${hit.getAttribute("data-first-run-step") ?? ""}`,
								);
						}
					}
				};
				new MutationObserver(records => {
					for (const record of records) {
						mark("+", record.addedNodes);
						mark("-", record.removedNodes);
					}
				}).observe(document.body, { childList: true, subtree: true });
			});
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
				.toBe("ready");

			const setup = page.getByRole("region", { name: /^(Set up OMPdesk|OMPdesk 시작하기)$/ });
			await expect(setup).toBeVisible({ timeout: 60_000 });
			await shoot("connect");
			await page
				.getByRole("button", { name: /^(Add custom endpoint|엔드포인트 직접 추가)$/ })
				.first()
				.click();
			await shoot("custom-form");
			// The session pane is rebuilt once right after launch, which drops what a form holds: fill until it keeps it.
			const providerId = page.getByLabel(/^(Provider ID|프로바이더 ID)/);
			await expect(async () => {
				await providerId.fill("audit-local");
				await page.getByLabel(/^(Base URL|기본 URL)/).fill(`http://127.0.0.1:${port}/v1`);
				await page.getByRole("textbox", { name: /^(API key|API 키)/ }).fill("sk-audit");
				await page
					.getByLabel(/^(Model ID|모델 ID)/)
					.first()
					.fill("audit-model");
				await expect(providerId).toHaveValue("audit-local", { timeout: 1000 });
				await page.getByRole("button", { name: /^(Add provider|프로바이더 추가)$/ }).click();
			}).toPass({ timeout: 30_000 });
			// The default model is picked on its own: no model or GitHub step, the setup closes and the composer is free.
			await expect(setup).toHaveCount(0, { timeout: 30_000 });
			await shoot("ready");

			const composer = page.locator("textarea").first();
			await composer.fill("Create hello.txt containing hello.");
			await page.keyboard.press("Enter");
			const card = page.locator('.omp-execution-group[data-state="complete"]');
			await expect(card).toBeVisible({ timeout: 90_000 });
			await expect(page.getByText("I created hello.txt for you.").first()).toBeVisible();
			await shoot("work-card");
			expect(await fs.readFile(path.join(project, "hello.txt"), "utf8")).toBe("hello\n");
			notes.push(`window ${await page.evaluate(() => `${innerWidth}x${innerHeight}`)}`);
		} finally {
			notes.push(
				...(await page
					.evaluate<string[]>(() => Reflect.get(window, "__setupLog") ?? [])
					.catch(() => ["page gone"])),
			);
			await fs.writeFile(
				path.join(directory ?? baseTemp(), `${prefix}-${test.info().repeatEachIndex}-findings.json`),
				JSON.stringify({ findings, notes, errors }, null, 2),
			);
			await exitApp(app);
			server.close();
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		expect(errors).toEqual([]);
	});
}

// The same first prompt on the user's own small model (OMP_GUI_REAL_WORK=1 spends its tokens): an isolated profile
// copied from the real one (e2e/real-omp.ts), so a provider is already connected and the window opens on the empty
// session; the first request must end in a finished work card with the file on disk, at the minimum window size.
for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`first prompt on the small model ends in a finished work card (${language} ${theme})`, async () => {
		test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "set OMP_GUI_REAL_WORK=1 to spend the small model's tokens");
		test.setTimeout(300_000);
		const real = await realOmpProfile({ language, themeName: theme });
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				real.project,
				`--user-data-dir=${real.desktop}`,
			],
			env: real.env,
		});
		const findings: Finding[] = [];
		const errors: string[] = [];
		const prefix = `real-${language}-${theme}`;
		const page = await app.firstWindow();
		page.on("pageerror", error => errors.push(error.message));
		try {
			await resize(app, 800, 600);
			const shoot = capturer(page, directory, prefix, findings);
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
				.toBe("ready");
			const composer = page.locator("textarea").first();
			await expect(composer).toBeVisible();
			await shoot("empty");
			await composer.fill(
				"Create the file hello.txt containing exactly the line hello. Then reply in one short sentence.",
			);
			await page.keyboard.press("Enter");
			await shoot("sent");
			const card = page.locator('.omp-execution-group[data-state="complete"]');
			await expect(card).toBeVisible({ timeout: 240_000 });
			await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
			await shoot("work-card");
			expect((await fs.readFile(path.join(real.project, "hello.txt"), "utf8")).trim()).toBe("hello");
		} finally {
			await fs.writeFile(
				path.join(directory ?? baseTemp(), `${prefix}-findings.json`),
				JSON.stringify({ findings, errors }, null, 2),
			);
			await exitApp(app);
			await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		expect(errors).toEqual([]);
	});
}
