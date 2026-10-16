import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The hover actions (time, copy, branch) of a message must sit in space the turn
// reserves for them: never over the message's last text line or its bubble, and
// showing them must not move the transcript. Geometry only, so the checks hold
// in every language and theme, for the last message above the composer, for a
// long last line, in a narrow window and for user bubbles.
// Capture before/after pictures with OMP_GUI_MESSAGE_ACTIONS=<dir>.

const captures = process.env.OMP_GUI_MESSAGE_ACTIONS;

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		short: "Fix the flaky release run.",
		long: `Please look at the release run that timed out and ${"keep going through every retry attempt and every cached certificate ".repeat(4)}then tell me what you find.`,
		reply: "I'll update the release notes first.\n\nAfter the tests finish I'll run the full check and ship it.",
		longReply: `Here is the plan: ${"the signing step reads the cached thumbprint instead of the secret, ".repeat(5)}so the final line wraps over several rows before it ends.`,
		last: "When the checks finish I'll run the full suite and ship it.",
	},
	ko: {
		short: "불안정한 배포 실행을 고쳐 주세요.",
		long: `시간이 초과된 배포 실행을 살펴보고 ${"모든 재시도와 캐시된 인증서를 하나씩 끝까지 확인한 다음 ".repeat(4)}무엇을 찾았는지 알려 주세요.`,
		reply: "먼저 배포 노트를 업데이트할게요.\n\n테스트가 끝나면 전체 검사를 돌리고 배포할게요",
		longReply: `계획은 이래요: ${"서명 단계가 시크릿 대신 캐시된 지문을 읽고 있어서 ".repeat(5)}마지막 줄이 여러 줄에 걸쳐 이어진 뒤에 끝나요.`,
		last: "검사가 모두 끝나면 전체 검사를 돌리고 배포할게요",
	},
} as const;

async function seedTranscript(file: string, language: Language): Promise<void> {
	const text = TEXT[language];
	const lines: Record<string, unknown>[] = [];
	let previous: string | null = null;
	let clock = Date.now() - 3_600_000;
	const add = (id: string, message: Record<string, unknown>) => {
		clock += 45_000;
		lines.push({
			type: "message",
			id,
			parentId: previous,
			timestamp: new Date(clock).toISOString(),
			message: { ...message, timestamp: clock },
		});
		previous = id;
	};
	const user = (id: string, body: string) => add(id, { role: "user", content: [{ type: "text", text: body }] });
	const reply = (id: string, body: string) =>
		add(id, {
			role: "assistant",
			content: [{ type: "text", text: body }],
			provider: "fixture",
			model: "local-fixture",
			stopReason: "stop",
		});
	user("u1", text.short);
	reply("a1", text.reply);
	user("u2", text.long);
	reply("a2", text.longReply);
	user("u3", text.short);
	reply("a3", text.last);
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

async function launch(language: Language, theme: Theme): Promise<{ app: ElectronApplication; page: Page }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-message-actions-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const seed = path.join(profile, "seed.jsonl");
	await seedTranscript(seed, language);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_SEED_SESSION: seed,
		OMP_GUI_OMP: await fixtureOmp(profile),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page };
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
}

interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface Measure {
	kind: string;
	index: number;
	/** The turn's height with the actions hidden, then shown. */
	heightIdle: number;
	heightShown: number;
	actions: Rect;
	turn: Rect;
	/** The last rendered line of the message's text. */
	lastLine: Rect;
	/** The whole bubble (user turns), else the text column. */
	body: Rect;
	label: string;
}

const intersects = (a: Rect, b: Rect) =>
	Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
	Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

/** Hover every turn in turn and measure its actions against its text. */
async function measureTurns(page: Page): Promise<Measure[]> {
	const turns = page.locator(".omp-assistant-turn:has(.omp-message-actions), .omp-user-turn");
	const count = await turns.count();
	const out: Measure[] = [];
	for (let index = 0; index < count; index++) {
		const turn = turns.nth(index);
		await turn.scrollIntoViewIfNeeded();
		await page.mouse.move(0, 0);
		await page.waitForTimeout(250);
		const heightIdle = await turn.evaluate(element => element.getBoundingClientRect().height);
		// Over the turn's top padding, mid-width: the turn navigator hugs the right edge. Hovered again on every
		// poll, so a pointer the turn moved out from under (a row above measured late on a loaded machine) or a
		// dropped move re-enters it; the height check below still catches actions that move the transcript.
		const actions = turn.locator(".omp-message-actions");
		await expect
			.poll(async () => {
				await turn.hover({ position: { x: (await turn.evaluate(element => element.clientWidth)) / 2, y: 3 } });
				return actions.evaluate(element => getComputedStyle(element).opacity);
			})
			.toBe("1");
		const measured = await turn.evaluate(element => {
			const rect = (box: DOMRect) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
			const isUser = element.classList.contains("omp-user-turn");
			const actionsBox = element.querySelector(".omp-message-actions");
			const body = isUser
				? element.querySelector(".omp-user-bubble")
				: element.querySelector(".omp-transcript-content");
			if (!actionsBox || !body) throw new Error("message turn without actions or body");
			// Last rendered text line: the last text node outside the actions.
			const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
			let last: Text | null = null;
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node.textContent?.trim() && !actionsBox.contains(node)) last = node as Text;
			}
			if (!last) throw new Error("message without text");
			const range = document.createRange();
			range.selectNodeContents(last);
			const lines = [...range.getClientRects()].filter(box => box.width > 0);
			const line = lines[lines.length - 1];
			if (!line) throw new Error("message text has no line box");
			return {
				heightShown: element.getBoundingClientRect().height,
				actions: rect(actionsBox.getBoundingClientRect()),
				turn: rect(element.getBoundingClientRect()),
				lastLine: rect(line),
				body: rect(body.getBoundingClientRect()),
				label: (last.textContent ?? "").trim().slice(-24),
			};
		});
		out.push({ kind: "turn", index, heightIdle, ...measured });
	}
	return out;
}

function check(measures: Measure[], where: string): void {
	expect(measures.length, `${where}: turns found`).toBeGreaterThanOrEqual(6);
	for (const m of measures) {
		const id = `${where} #${m.index} "${m.label}"`;
		expect(intersects(m.actions, m.lastLine), `${id}: actions cover the last line`).toBe(false);
		expect(intersects(m.actions, m.body), `${id}: actions sit over the message body`).toBe(false);
		expect(m.actions.top, `${id}: actions start inside the turn`).toBeGreaterThanOrEqual(m.turn.top - 0.5);
		expect(m.actions.bottom, `${id}: actions end inside the turn`).toBeLessThanOrEqual(m.turn.bottom + 0.5);
		expect(m.actions.left, `${id}: actions inside the window`).toBeGreaterThanOrEqual(0);
		expect(m.heightShown, `${id}: hover moved the transcript`).toBeCloseTo(m.heightIdle, 1);
	}
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`message actions never cover the message ${language} ${theme}`, async () => {
			test.setTimeout(180_000);
			const { app, page } = await launch(language, theme);
			try {
				for (const [name, width, height] of [
					["wide", 1280, 800],
					["narrow", 560, 700],
				] as const) {
					await resize(app, width, height);
					await expect(page.locator(".omp-user-turn")).toHaveCount(3);
					await page.waitForTimeout(500);
					// The last message sits next to the composer: scroll to the end first.
					const scroller = page.locator(".omp-transcript-scroll").first();
					await scroller.evaluate(element => {
						element.scrollTop = element.scrollHeight;
					});
					await page.waitForTimeout(300);
					const measures = await measureTurns(page);
					if (captures) {
						await fs.mkdir(captures, { recursive: true });
						await page.screenshot({
							path: path.join(captures, `${language}-${theme}-${name}.png`),
							animations: "disabled",
						});
					}
					check(measures, `${language} ${theme} ${name}`);
				}
			} finally {
				await exitApp(app);
			}
		});
