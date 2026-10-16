import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { TITLE_HARD_CHARS, TITLE_HARD_CJK_CHARS } from "../resources/gui-bridge/auto-title-core";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in: this audit spends model tokens (one turn per case on the user's `smol` model, plus the title on
// stock's title roles and, for a title past the limits, one retry on the user's `default` role) and copies
// credentials only into a private disposable directory. Ordinary test runs never make calls.
//
// A first message gets a short plain title in its own language: the bridge gives stock's title paths stock's own
// `title-system.md` plus the language, length and form line (auto-title-core.ts), with the reply language as the
// fallback when it is not English and the same line without it when it is off, and OMPdesk holds
// `title.icons: boring`, so no icon/code card heads it. A title past the limits gets one shorter retry on the
// `default` role's model (kept as the user configured it here; the session itself runs on `smol`) and is then kept
// whole up to the hard cap; the model's own answers, the retry's model and its usage come from the bridge's
// `auto-title: title` line in the private profile's omp log (`<profile>/logs`).
const RESULT_FILE = "/tmp/real-auto-title.json";
// The first four are also the compression examples the title prompt shows (auto-title-core.ts); the last two are
// held out, so the audit also sees messages the examples do not answer.
const CASES = [
	{
		replyLanguage: "Korean",
		prompt: "로그인 화면에서 비밀번호를 틀려도 에러 메시지가 안 보이는 버그를 고치는 방법을 한 문장으로 알려 줘.",
	},
	{
		replyLanguage: "Korean",
		prompt: "작업 현황판 화면 디자인을 더 깔끔하게 바꾸고 싶은데 먼저 무엇부터 보면 좋을지 한 문장으로 알려 줘.",
	},
	{
		replyLanguage: "Korean",
		prompt: "결제 API 호출이 가끔 타임아웃 나는데 재시도 로직을 어디에 넣으면 좋을지 한 문장으로 알려 줘.",
	},
	{
		replyLanguage: null,
		prompt:
			"The CSV export button downloads an empty file whenever the table has filters applied; tell me in one sentence where to look first.",
	},
	{
		replyLanguage: "Korean",
		prompt: "알림 설정 화면에서 토글을 꺼도 푸시 알림이 계속 오는 문제를 어디부터 보면 될지 한 문장으로 알려 줘.",
	},
	{
		replyLanguage: null,
		prompt:
			"Our nightly backup job to S3 silently skips files larger than 5 GB; in one sentence, what should I check first?",
	},
] as const;
const HANGUL = /\p{Script=Hangul}/u;
/** Stock's card form, `<icon> <CODE>: <title>` (utils/title-card.ts). */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
const EMOJI = /\p{Extended_Pictographic}/u;

const results: Array<Record<string, unknown>> = [];

test.afterAll(async () => {
	if (results.length > 0) await fs.writeFile(RESULT_FILE, JSON.stringify(results, null, 2));
});

/** The bridge's `auto-title: title` records in the omp logs under `profile` (omp buffers its log for up to 1 s). */
async function titleRecords(profile: string): Promise<Array<Record<string, unknown>>> {
	const files = (await fs.readdir(profile, { recursive: true })).filter(file => /(^|\/)omp\.[^/]*\.log$/.test(file));
	const records: Array<Record<string, unknown>> = [];
	for (const file of files) {
		for (const line of (await fs.readFile(path.join(profile, file), "utf8")).split("\n")) {
			if (!line.includes('"auto-title: title"')) continue;
			const record: unknown = JSON.parse(line);
			if (record && typeof record === "object") records.push(Object.fromEntries(Object.entries(record)));
		}
	}
	return records;
}

/** `usage.cost.total` of a stock reply's usage, when it is there. */
function costOf(usage: unknown): number | null {
	if (typeof usage !== "object" || usage === null || !("cost" in usage)) return null;
	const cost = usage.cost;
	if (typeof cost !== "object" || cost === null || !("total" in cost)) return null;
	return typeof cost.total === "number" ? cost.total : null;
}

for (const [index, { replyLanguage, prompt }] of CASES.entries()) {
	test(`real omp names first message ${index + 1} with a short plain title in its language`, async () => {
		test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
		test.setTimeout(420_000);
		const { profile, project, desktop, env, smol } = await realOmpProfile(
			{ ...(replyLanguage ? { replyLanguage } : {}), autoTitle: true },
			{ keepDefaultRole: true },
		);
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
			// The turn itself on the small model; the `default` role (the retry's model) stays the user's.
			const [provider, ...modelId] = smol.split("/");
			const switched = await page.evaluate(([p, m]) => window.omp.rpc.setModel(p, m), [
				provider ?? "",
				modelId.join("/"),
			] as const);
			expect(switched.success, JSON.stringify(switched)).toBe(true);
			await page.evaluate(() => {
				const ends: string[] = [];
				Object.assign(window, { __turnEnds: ends });
				window.omp.events.onTabBatch(events => {
					for (const event of events) if (event.type === "agent_end") ends.push(event.type);
				});
			});

			const input = page.locator("textarea").first();
			await input.fill(prompt);
			await input.press("Enter");
			await expect
				.poll(() => page.evaluate(() => (Reflect.get(window, "__turnEnds") as string[]).length), {
					timeout: 180_000,
				})
				.toBeGreaterThan(0);
			await expect.poll(sessionName, { timeout: 60_000 }).not.toBe("");
			const title = await sessionName();
			await expect(page.locator("[data-titlebar-session-name]")).toHaveText(title);

			await expect.poll(async () => (await titleRecords(profile)).length, { timeout: 15_000 }).toBeGreaterThan(0);
			const record = (await titleRecords(profile)).at(-1);

			const words = title.split(/\s+/).filter(Boolean);
			const korean = HANGUL.test(prompt);
			const report = {
				replyLanguage,
				prompt,
				answer: record?.answer,
				retryModel: record?.retryModel,
				retry: record?.retry,
				retryCost: costOf(record?.retryUsage),
				retryUsage: record?.retryUsage,
				title,
				characters: title.length,
				words: words.length,
			};
			results.push(report);
			console.log(`real-auto-title ${JSON.stringify(report)}`);

			expect(record?.title).toBe(title);
			expect(title).not.toMatch(CARD_LINE);
			expect(title).not.toMatch(EMOJI);
			expect(title).not.toMatch(/…|\.\.\./);
			const cap = korean ? TITLE_HARD_CJK_CHARS : TITLE_HARD_CHARS;
			expect(title.length).toBeLessThanOrEqual(Math.max(cap, ...words.map(word => word.length)));
			if (korean) expect(title).toMatch(HANGUL);
			else expect(title).not.toMatch(HANGUL);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
