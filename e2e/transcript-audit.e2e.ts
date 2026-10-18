import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in visual audit of the transcript outside the work card
// (OMP_GUI_TRANSCRIPT_AUDIT=<dir>): a seeded session with every message kind
// (markdown stress, math, wide tables, long lines, images, RTL/CJK, custom
// cards, compaction and branch summaries, very long messages, a side branch),
// read page by page per language and theme, then the real flows: hover and
// keyboard actions, message copy, selection copy, /copy, /branch (edit and
// resend), branching to a new tab, the session tree, a narrow window and a
// 2×2 split. Each capture records overflow facts; clipboard results land next
// to the PNGs so a review starts from facts.

const directory = process.env.OMP_GUI_TRANSCRIPT_AUDIT;
test.skip(!directory, "set OMP_GUI_TRANSCRIPT_AUDIT=<dir> to capture the transcript audit");

type Language = "en" | "ko";
type Theme = "light" | "dark";

interface Finding {
	shot: string;
	kind: string;
	detail: string;
}

const MARKDOWN_EN = `## Release plan comparison

Both plans ship the same fixes; they differ in **when** the Windows installer is signed. See the [release checklist](https://example.com/release/checklist) or the raw log at https://ci.example.com/runs/1234567890/jobs/9876543210/logs/raw?attempt=2&format=plain&download=false.

| Plan | Owner | Windows signing | macOS notarization | Risk | Rollback | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| A — batch | Release bot | After smoke tests on the self-hosted runner | Same job, pinned certificate | Low | Revert the tag, keep the DMG | Needs \`release.yml\` edits in two places |
| B — staged | Maintainer | Before smoke tests | Separate job | Medium | Pull both assets | One manual approval per release |

Inline path: \`src/renderer/components/chat/very/deeply/nested/folder/structure/TranscriptRowWithAnExtremelyLongName.tsx\`.

\`\`\`ts
export function signInstaller(path: string, certificate: string, options: { timestampServer: string; retries: number; verbose: boolean }): Promise<SignResult> { return run(["signtool", "sign", "/fd", "sha256", "/tr", options.timestampServer, "/f", certificate, path]); }
\`\`\`

1. Tag the release
   - Wait for **build** and **check**
   - [x] Smoke tests pass
   - [ ] Windows installer signed
2. Publish

> The signing step can't be retried once the timestamp server rejects the request.

Expected download time $t = \\frac{S}{B}$ for size $S$ and bandwidth $B$:

$$
P(\\text{success}) = 1 - \\prod_{i=1}^{n} (1 - p_i)
$$

![release diagram](https://example.com/diagram.png)

Footnote reference[^1].

[^1]: Timestamp servers rate-limit at 10 requests a minute.

---

**Done.** Ready for your review.`;

const RTL_PROMPT =
	"배포 메모를 정리해 주세요. 아랍어 고객 문구 «مرحبا بكم في التحديث الجديد» 는 그대로 두고, 히브리어 שלום עולם 도 섞여 있어요. 日本語の注記も残してください。";

const MARKDOWN_KO = `## 배포 메모

아랍어 문구는 그대로 둘게요: «مرحبا بكم في التحديث الجديد، يرجى إعادة تشغيل التطبيق» — 그리고 히브리어 שלום עולם, 버전 v0.27.0 도 함께요.

مرحبا بكم في التحديث الجديد. يرجى إعادة تشغيل التطبيق بعد التثبيت (الإصدار 0.27).

| 언어 | 문구 | 방향 |
| --- | --- | --- |
| 한국어 | 새 버전을 설치했어요 | LTR |
| العربية | تم تثبيت الإصدار الجديد | RTL |
| עברית | הגרסה החדשה הותקנה | RTL |
| 日本語 | 新しいバージョンをインストールしました | LTR |

긴 해시: \`${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".repeat(2)}\`

${"这是一段没有任何空格的很长的中文句子用来检查在窄窗口里是否能够正确换行而不会撑破聊天记录的宽度".repeat(3)}

이모지: 👩‍💻 🇰🇷 🏳️‍🌈

\`\`\`python
# 한국어 주석이 있는 코드예요
print("안녕하세요")  # مرحبا
\`\`\``;

const LONG_PROMPT = [
	"Here is the full context for the flaky release run, pasted as-is so nothing gets lost.",
	...Array.from(
		{ length: 14 },
		(_, index) =>
			`Paragraph ${index + 1}: the Windows packaging step waited on the signing service for several minutes before it timed out, and the retry picked up a stale certificate from the cache, so the installer that reached the release page was signed with the previous key. ${index % 3 === 0 ? "This happened twice this week." : ""}`,
	),
	"```\n" +
		Array.from(
			{ length: 12 },
			(_, index) =>
				`2026-10-14T03:${String(10 + index).padStart(2, "0")}:00Z [signtool] attempt=${index} status=retry server=http://timestamp.example.com/rfc3161?nonce=${"a".repeat(80)}`,
		).join("\n") +
		"\n```",
	"Can you find the root cause and propose the smallest fix?",
].join("\n\n");

const LONG_ANSWER = [
	"## Root cause",
	...Array.from({ length: 24 }, (_, index) =>
		[
			`### Step ${index + 1}: ${index % 2 ? "verify the cache key" : "trace the retry path"}`,
			`The retry path re-reads \`SIGNING_CERT_THUMBPRINT\` from the job cache (entry ${index + 1}). When the timestamp server rejects a request, the second attempt starts from the cached value instead of the secret, so a rotated certificate never reaches the signer. ${"This is consistent with every failing run we have. ".repeat(2)}`,
			"- Cache key: `win-sign-<hash of scripts/mac-signing.json>`\n- Secret: `MAC_SIGNING_P12_BASE64`",
		].join("\n\n"),
	),
	"## Fix\n\nDrop the cache for the thumbprint and read the secret on every attempt.",
].join("\n\n");

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6VQAAAAASUVORK5CYII=";

/** A stock-shaped session journal: one active branch plus an abandoned side branch. */
async function seedTranscript(file: string): Promise<void> {
	const icon = (await fs.readFile(path.resolve("resources/icon.png"))).toString("base64");
	const start = Date.now() - 3_600_000;
	const lines: Record<string, unknown>[] = [];
	let previous: string | null = null;
	let clock = start;
	const add = (id: string, message: Record<string, unknown>, parentId: string | null = previous) => {
		clock += 45_000;
		lines.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(clock).toISOString(),
			message: { ...message, timestamp: clock },
		});
		previous = id;
	};
	const usage = {
		input: 18_240,
		output: 1_312,
		cacheRead: 9_000,
		cacheWrite: 0,
		totalTokens: 28_552,
		cost: { input: 0.05, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.08 },
	};
	const reply = (text: string, extra: Record<string, unknown> = {}) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "fixture",
		model: "local-fixture",
		stopReason: "stop",
		usage,
		...extra,
	});
	add("u1", {
		role: "user",
		content: [
			{
				type: "text",
				text: "Compare the two release plans and keep the table compact. The screenshot is attached.",
			},
			{ type: "image", mimeType: "image/png", data: icon },
		],
	});
	add("a1", {
		...reply(MARKDOWN_EN),
		content: [
			{
				type: "thinking",
				thinking: "Two plans, one table. The signing order is the only real difference, so lead with it.",
			},
			{ type: "text", text: MARKDOWN_EN },
		],
	});
	add("b1", {
		role: "bashExecution",
		command: "git log --oneline -3",
		output:
			"d7091ab release: v0.27.0\n7470497 fix(settings,panels,stats): settings fit the smallest window\n9dd0dfe fix(work): a reload shows the rows the live run showed",
		exitCode: 0,
	});
	add("c1", {
		role: "compactionSummary",
		summary:
			"## Earlier work\n\n- Compared plans A and B\n- Kept the signing order question open\n- Dropped three exploratory CI runs",
		shortSummary: "Kept the release plan comparison; dropped exploratory CI runs.",
		tokensBefore: 182_000,
		tokensAfter: 24_000,
		method: "remote",
	});
	// The abandoned side branch the tree and the branch summary point at.
	const fork = previous;
	add("x1", { role: "user", content: [{ type: "text", text: "Draft the release notes in English only." }] }, fork);
	add("x2", reply("Here are English-only notes. (This branch was abandoned.)"));
	add(
		"s1",
		{
			role: "branchSummary",
			summary: "Tried English-only release notes, then went back: the customer copy must stay in each language.",
			fromId: "x2",
		},
		fork,
	);
	add("u2", { role: "user", content: [{ type: "text", text: RTL_PROMPT }] });
	add("a2", reply(MARKDOWN_KO));
	add("m1", {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "Advisor notes",
		details: {
			notes: [
				{
					note: "The Arabic string ends with a comma in one place and not the other; pick one before it ships.",
					severity: "concern",
					advisor: "default",
				},
				{ note: "Consider pinning the timestamp server.", severity: "nit", advisor: "default" },
			],
		},
	});
	add("m2", {
		role: "custom",
		customType: "skill-prompt",
		display: true,
		content: "## Release checklist\n\n1. Tag\n2. Watch the run\n3. Announce",
		details: {
			name: "release-checklist",
			args: "--dry-run --channel stable",
			path: "skills/release/SKILL.md",
			lineCount: 42,
		},
	});
	add("m3", {
		role: "custom",
		customType: "release-note",
		display: true,
		content: "**Extension message** with a [link](https://example.com) and `code`.",
	});
	add("u3", { role: "user", content: [{ type: "text", text: LONG_PROMPT }] });
	add("a3", reply(LONG_ANSWER));
	add("m4", {
		role: "custom",
		customType: "handoff",
		display: true,
		content:
			"<handoff-context>\n## Handoff\n\nThe thumbprint cache is gone; the next session verifies one signed installer.\n</handoff-context>",
	});
	add("u4", {
		role: "user",
		content: [
			{ type: "text", text: "Thanks — ship it. 고마워요!" },
			{ type: "image", mimeType: "image/png", data: TINY_PNG },
		],
	});
	add("a4", reply("Shipped **v0.27.0**. Both installers are signed with the rotated certificate."));
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; project: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-transcript-audit-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const seed = path.join(profile, "seed.jsonl");
	await seedTranscript(seed);
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
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, profile, project };
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
}

/** Overflow facts: the page, the transcript, and anything spilling past its message column. */
async function inspect(page: Page, shot: string): Promise<Finding[]> {
	const found = await page.evaluate(() => {
		const out: { kind: string; detail: string }[] = [];
		const describe = (element: Element) => {
			const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 50) ?? "";
			const name = typeof element.className === "string" ? element.className.split(" ").slice(0, 2).join(".") : "";
			return `${element.tagName.toLowerCase()}${name ? `.${name}` : ""} "${label}"`;
		};
		if (document.documentElement.scrollWidth > innerWidth + 1)
			out.push({ kind: "page-overflow", detail: `${document.documentElement.scrollWidth} > ${innerWidth}` });
		for (const scroller of document.querySelectorAll<HTMLElement>(".omp-transcript-scroll")) {
			if (scroller.scrollWidth > scroller.clientWidth + 1)
				out.push({ kind: "transcript-hscroll", detail: `${scroller.scrollWidth} > ${scroller.clientWidth}` });
			const edge = scroller.getBoundingClientRect().right;
			for (const element of scroller.querySelectorAll(".omp-transcript-content *")) {
				const box = element.getBoundingClientRect();
				if (box.width === 0 || box.right <= edge + 1) continue;
				// Inside a horizontal scroll container the spill is intended.
				let clipped = false;
				for (let parent = element.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
					const overflow = getComputedStyle(parent).overflowX;
					if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
						clipped = true;
						break;
					}
				}
				if (!clipped)
					out.push({
						kind: "spill",
						detail: `${describe(element)} right=${Math.round(box.right)} > ${Math.round(edge)}`,
					});
			}
		}
		for (const popup of document.querySelectorAll("[role=menu], [role=listbox], [role=dialog], [role=tooltip]")) {
			const box = popup.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1)
				out.push({ kind: "popup-outside", detail: describe(popup) });
		}
		return out;
	});
	return found.map(entry => ({ shot, ...entry }));
}

function capturer(page: Page, prefix: string, findings: Finding[]) {
	let index = 0;
	return async (name: string) => {
		if (!directory) return;
		index += 1;
		const shot = `${prefix}-${String(index).padStart(2, "0")}-${name}`;
		await page.screenshot({ path: path.join(directory, `${shot}.png`), scale: "css", animations: "disabled" });
		findings.push(...(await inspect(page, shot)));
	};
}

const COPY = {
	en: {
		send: "Send",
		copyMessage: "Copy message text",
		branch: "Branch to a new tab from here",
		details: "Context details",
		splitRight: "Split right",
		splitBelow: "Split below",
		openFailed: "Couldn't open session",
	},
	ko: {
		send: "보내기",
		copyMessage: "메시지 텍스트 복사",
		branch: "여기서 새 탭으로 분기",
		details: "컨텍스트 상세 보기",
		splitRight: "오른쪽으로 분할",
		splitBelow: "아래로 분할",
		openFailed: /세션을 열 수 없어요|세션을 열지 못했어요/,
	},
} as const;

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`transcript audit ${language} ${theme}`, async () => {
			test.setTimeout(420_000);
			const { app, page, profile, project } = await launch(language, theme);
			const findings: Finding[] = [];
			const clipboard: Record<string, { text: string; html?: string }> = {};
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			const prefix = `${language}-${theme}`;
			const shoot = capturer(page, prefix, findings);
			const copy = COPY[language];
			const composer = page.locator("textarea").first();
			const scroller = page.locator(".omp-transcript-scroll").first();
			// The clipboard is the system's: the four runs share one worker (no parallel
			// mode) so their copies never race, and the user's clipboard comes back after.
			const readClipboard = () =>
				app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
			const clearClipboard = () => app.evaluate(({ clipboard }) => clipboard.clear());
			/** The clipboard once a copy has landed (empty after a second means nothing was copied). */
			const readCopied = async () => {
				for (let attempt = 0; attempt < 10; attempt++) {
					const value = await readClipboard();
					if (value.text || value.html) return value;
					await page.waitForTimeout(100);
				}
				return readClipboard();
			};
			const saved = await readClipboard();
			// Test windows never take focus; the page is told it has it, as a clicked window does.
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
			const send = async (text: string) => {
				await composer.fill(text);
				await page.getByRole("button", { name: copy.send, exact: true }).first().click();
			};
			// Scrolls go through the reader's own gestures (Home, the wheel): a scrollTop
			// write is no gesture, so the tail follower would rightly keep the view.
			const toTop = async () => {
				await scroller.focus();
				await page.keyboard.press("Home");
				await page.waitForTimeout(400);
			};
			/** One wheel step of `fraction` viewports; false once the view no longer moves. */
			const wheel = async (fraction: number) => {
				const before = await scroller.evaluate(element => element.scrollTop);
				const box = await scroller.boundingBox();
				if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.wheel(0, ((box?.height ?? 600) * fraction) | 0);
				await page.waitForTimeout(350);
				return (await scroller.evaluate(element => element.scrollTop)) !== before;
			};
			/**
			 * Select the first `selector` match containing `needle` and copy it the way
			 * Edit › Copy does. The transcript is virtualized, so it reads down from the
			 * top until the row is mounted.
			 */
			const copySelection = async (name: string, selector: string, needle = "") => {
				await clearClipboard();
				let ok = false;
				await toTop();
				for (let attempt = 0; attempt < 40 && !ok; attempt++) {
					ok = await page.evaluate(
						({ selector, needle }) => {
							const target = [...document.querySelectorAll(selector)].find(element =>
								element.textContent?.includes(needle),
							);
							if (!target) return false;
							target.scrollIntoView({ block: "center" });
							const range = document.createRange();
							range.selectNodeContents(target);
							const selection = getSelection();
							selection?.removeAllRanges();
							selection?.addRange(range);
							return true;
						},
						{ selector, needle },
					);
					if (!ok && !(await wheel(0.8))) break;
				}
				if (!ok) {
					clipboard[name] = { text: `<no match for ${selector} ${needle}>` };
					return;
				}
				await page.waitForTimeout(150);
				await shoot(`select-${name}`);
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.copy());
				await page.waitForTimeout(150);
				clipboard[name] = await readCopied();
				await page.evaluate(() => getSelection()?.removeAllRanges());
			};
			/** Read the whole transcript page by page, top to bottom. */
			const readThrough = async (name: string, limit = 18) => {
				await toTop();
				for (let pageIndex = 0; pageIndex < limit; pageIndex++) {
					await shoot(`${name}-${String(pageIndex).padStart(2, "0")}`);
					if (!(await wheel(0.85))) break;
				}
			};
			/** Reveal a turn's actions the keyboard way (focus-within), as hover does. */
			const reveal = async (turn: Locator) => {
				await turn.getByRole("button", { name: copy.copyMessage }).focus();
				await page.waitForTimeout(200);
			};
			try {
				await expect(page.getByText("Both installers are signed with the rotated certificate.")).toBeVisible({
					timeout: 30_000,
				});
				await page.waitForTimeout(600);
				await shoot("latest");
				// The compaction keeps the messages before it behind one button.
				await toTop();
				await page.getByRole("button", { name: /^(Show \d+ earlier messages?|이전 메시지 \d+개 보기)$/ }).click();
				await page.waitForTimeout(500);
				await shoot("earlier-shown");
				await readThrough("page");

				// A user bubble's actions by keyboard, then its copy action.
				await toTop();
				const firstUser = page.locator(".omp-user-turn").filter({ hasText: "Compare the two release plans" });
				await reveal(firstUser);
				await shoot("user-actions");
				await clearClipboard();
				await firstUser.getByRole("button", { name: copy.copyMessage }).click();
				await page.waitForTimeout(250);
				await shoot("user-copied");
				clipboard["button-user"] = await readCopied();
				await page.keyboard.press("Tab");
				await page.waitForTimeout(150);
				await shoot("user-focus-next");
				await page.keyboard.press("Tab");
				await page.waitForTimeout(150);
				await shoot("user-focus-after");

				// Assistant copy action: the markdown source, not the rendered text.
				await toTop();
				const firstAnswer = page.locator(".omp-assistant-turn").filter({ hasText: "Release plan comparison" });
				await reveal(firstAnswer);
				await firstAnswer.getByRole("button", { name: copy.copyMessage }).scrollIntoViewIfNeeded();
				await shoot("assistant-actions");
				await clearClipboard();
				await firstAnswer.getByRole("button", { name: copy.copyMessage }).click();
				await page.waitForTimeout(250);
				clipboard["button-assistant"] = await readCopied();

				// Selection copy fidelity: a table, a code block, math, a whole reply, RTL text.
				await copySelection("table", ".omp-assistant-turn table", "Windows signing");
				await copySelection("code", ".omp-assistant-turn pre", "signInstaller");
				await copySelection("math", ".omp-assistant-turn .katex-display");
				await copySelection("inline-math", ".omp-assistant-turn p", "Expected download time");
				await copySelection("reply", ".omp-assistant-turn .omp-transcript-content", "Release plan comparison");
				await copySelection("user-bubble", ".omp-user-bubble", "Compare the two");
				await copySelection("rtl-table", ".omp-assistant-turn table", "العربية");
				await copySelection("rtl-paragraph", ".omp-assistant-turn p", "يرجى");
				await copySelection("rtl-prompt", ".omp-user-bubble", "שלום");
				await copySelection("advisor", ".omp-custom-turn", "Arabic string");

				// Context cards opened.
				await toTop();
				const details = page.getByRole("button", { name: copy.details });
				for (let index = 0; index < (await details.count()); index++) await details.nth(index).click();
				await details.first().scrollIntoViewIfNeeded();
				await page.waitForTimeout(300);
				await shoot("context-open");

				// /copy.
				await send("/copy");
				await page.waitForTimeout(500);
				await shoot("copy-dialog");
				await page.keyboard.press("Escape");
				await page.waitForTimeout(200);

				// The session tree.
				await send("/tree");
				await page.waitForTimeout(800);
				await shoot("tree");
				await page.keyboard.press("Escape");
				await page.waitForTimeout(300);

				// Narrow window: read through again, then the actions.
				await resize(app, 800, 600);
				await page.waitForTimeout(500);
				await readThrough("narrow", 40);
				await toTop();
				await reveal(firstUser);
				await shoot("narrow-user-actions");
				await resize(app, 1440, 900);
				await page.waitForTimeout(400);

				// Branch from a reply into a new tab.
				const activeSession = async () =>
					(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.sessionPath ?? "";
				const origin = await activeSession();
				await toTop();
				await reveal(firstAnswer);
				await firstAnswer.getByRole("button", { name: copy.branch }).click();
				// The new tab is the active one and sits on the forked session file.
				await expect.poll(activeSession).toContain("fixture-fork-");
				await page.waitForTimeout(1500);
				await shoot("branched-new-tab");
				// No "Couldn't open session" toast; the fork holds the path up to that reply and nothing after it.
				await expect(page.getByText(copy.openFailed)).toHaveCount(0);
				await expect(
					page.locator(".omp-assistant-turn").filter({ hasText: "Release plan comparison" }),
				).toBeVisible();
				await expect(page.getByText("Both installers are signed with the rotated certificate.")).toHaveCount(0);
				// Back to the original session for the rest of the flows.
				await page.locator(`[data-session-path="${origin}"]`).first().click();
				await expect.poll(activeSession).toBe(origin);
				await page.waitForTimeout(800);

				// Edit and resend: /branch picks the RTL prompt; its text returns to the composer.
				await send("/branch");
				await page.waitForTimeout(500);
				await shoot("branch-picker");
				await page.keyboard.type(language === "ko" ? "배포" : "release");
				await page.waitForTimeout(250);
				await shoot("branch-picker-search");
				await page.keyboard.type("zzqx");
				await page.waitForTimeout(250);
				await shoot("branch-picker-no-match");
				for (let index = 0; index < 4; index++) await page.keyboard.press("Backspace");
				await page.keyboard.press("Enter");
				await page.waitForTimeout(1200);
				await shoot("branch-edit");
				clipboard["composer-after-branch"] = { text: await composer.inputValue() };

				// 2×2: four panes over the same seeded session.
				await composer.fill("");
				const spawn = async () => {
					const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
					if (!spawned?.tabId) throw new Error("expected a background tab");
					const id = spawned.tabId;
					await expect
						.poll(
							async () =>
								(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === id)?.status,
						)
						.toBe("ready");
					return id;
				};
				const sessionRow = async (id: string) => {
					await page.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "bash", command: `fixture:title:Pane ${id}` }),
						id,
					);
					return page
						.locator("[data-session-path]")
						.filter({ hasText: `Pane ${id}` })
						.first();
				};
				const second = await spawn();
				await (await sessionRow(second)).click({ button: "right" });
				await page.getByRole("menuitem", { name: copy.splitRight }).click();
				await expect(page.locator(".omp-session-pane")).toHaveCount(2);
				for (const column of [0, 1]) {
					const id = await spawn();
					await page.locator(".omp-session-pane").nth(column).locator("textarea").first().click();
					await (await sessionRow(id)).click({ button: "right" });
					await page.getByRole("menuitem", { name: copy.splitBelow }).click();
				}
				await expect(page.locator(".omp-session-pane")).toHaveCount(4);
				await page.waitForTimeout(1500);
				await shoot("split-4");
				for (const pane of [0, 3]) {
					const paneScroller = page.locator(".omp-session-pane").nth(pane).locator(".omp-transcript-scroll");
					await paneScroller.focus();
					await page.keyboard.press("Home");
					for (let step = 0; step < 4; step++) {
						await page.waitForTimeout(350);
						await shoot(`split-4-pane${pane}-${step}`);
						const box = await paneScroller.boundingBox();
						if (!box) break;
						await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
						await page.mouse.wheel(0, box.height * 2);
					}
				}
				const corner = page.locator(".omp-session-pane").nth(3).locator(".omp-user-turn").last();
				await reveal(corner);
				await shoot("split-4-actions");
			} finally {
				if (directory) {
					await fs.writeFile(
						path.join(directory, `${prefix}-findings.json`),
						JSON.stringify({ findings, errors }, null, 2),
					);
					await fs.writeFile(path.join(directory, `${prefix}-clipboard.json`), JSON.stringify(clipboard, null, 2));
				}
				await app.evaluate(({ clipboard }, saved) => clipboard.write(saved), saved);
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
