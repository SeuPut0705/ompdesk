import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { TITLE_MAX_CJK_CHARS, TITLE_MAX_WORDS } from "../resources/gui-bridge/auto-title-core";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in: this audit spends model tokens (one turn on the `smol` model the isolated profile
// makes the main one, plus the title and its card on stock's title roles) and copies credentials only
// into a private disposable directory. Ordinary test runs never make calls.
//
// A Korean first message under the Korean reply language gets a Korean title: the bridge gives stock's
// title paths stock's own `title-system.md` plus the language and length line (auto-title-core.ts).
const RESULT_FILE = "/tmp/real-auto-title.json";
const PROMPT = "로그인 화면에서 비밀번호를 틀려도 에러 메시지가 안 보이는 버그를 고치는 방법을 한 문장으로 알려 줘.";
const HANGUL = /\p{Script=Hangul}/u;
/** Stock's card form, `<icon> <CODE>: <title>` (utils/title-card.ts). */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;

test("real omp names a Korean first message with a short Korean title", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(420_000);
	const { profile, project, desktop, env } = await realOmpProfile({ replyLanguage: "Korean", autoTitle: true });
	// A shell started from an omp session inherits its PI_NO_TITLE (stock sets it for its own RPC modes), which
	// OMPdesk respects as the person's choice to turn titles off.
	Reflect.deleteProperty(env, "PI_NO_TITLE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		// The session's own name (stock `get_state`), not the title bar, which shows the first prompt until then.
		const sessionName = async () => {
			const state = await page.evaluate(() => window.omp.rpc.getState());
			const data = state.data;
			return data && typeof data === "object" && "sessionName" in data && typeof data.sessionName === "string"
				? data.sessionName
				: "";
		};
		expect(await sessionName()).toBe("");
		await page.evaluate(() => {
			const ends: string[] = [];
			Object.assign(window, { __turnEnds: ends });
			window.omp.events.onTabBatch(events => {
				for (const event of events) if (event.type === "agent_end") ends.push(event.type);
			});
		});

		const input = page.locator("textarea").first();
		await input.fill(PROMPT);
		await input.press("Enter");
		await expect
			.poll(() => page.evaluate(() => (Reflect.get(window, "__turnEnds") as string[]).length), { timeout: 180_000 })
			.toBeGreaterThan(0);
		await expect.poll(sessionName, { timeout: 60_000 }).not.toBe("");
		const title = await sessionName();
		await expect(page.locator("[data-titlebar-session-name]")).toHaveText(title);

		const plain = CARD_LINE.exec(title)?.[3] ?? title;
		const words = plain.split(/\s+/).filter(Boolean);
		const report = { prompt: PROMPT, title, plain, characters: plain.length, words: words.length };
		await fs.writeFile(RESULT_FILE, JSON.stringify(report, null, 2));
		console.log(`real-auto-title ${JSON.stringify(report)}`);

		expect(plain).toMatch(HANGUL);
		expect(words.length).toBeLessThanOrEqual(TITLE_MAX_WORDS);
		expect(plain.length).toBeLessThanOrEqual(Math.max(TITLE_MAX_CJK_CHARS, words[0]?.length ?? 0));
		expect(plain).not.toMatch(/…|\.\.\./);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
