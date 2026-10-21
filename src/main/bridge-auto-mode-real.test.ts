import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Opt-in audit on the user's real omp and credentials (`OMP_GUI_REAL_WORK=1`; it spends a few tokens, one judge
 * request a prompt on the `judge` role chain). Copies `config.yml` and `agent.db` into a private 0700 agent dir, runs
 * the bridge's `modes.auto_mode_decide` on real prompts as a new session's first message and prints each decision
 * with its model, latency and the judge's probabilities (`AUTO_MODE_REAL` lines on stdout). The clear cases must come
 * out as the product intends; every decision must arrive inside the deadline.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const agentDir = join(homedir(), ".omp", "agent");
const enabled = process.env.OMP_GUI_REAL_WORK === "1" && existsSync(omp) && existsSync(join(agentDir, "agent.db"));

type Mode = "plan" | "goal" | "none";

const PROMPTS: Array<{ text: string; expect?: Mode }> = [
	// Large but concrete (what to split and what to update are named): either answer is acceptable.
	{ text: "Refactor the whole settings module into separate stores across all packages and update every caller." },
	{ text: "Keep going until all the tests pass, then stop.", expect: "goal" },
	{ text: "What does the session manager do when a tab closes?", expect: "none" },
	{ text: "Rename the variable foo to count in utils.ts", expect: "none" },
	{ text: "Add OAuth login with refresh tokens, a new settings page and database migrations for a multi-tenant app." },
	{ text: "Make the build green, retry until `bun run check` exits 0." },
];

/**
 * Long first messages of a new session, as the user writes them. Concrete work requests, however long, are none
 * (the reported bug: every long first message went to Plan); only a message that asks for a plan or design before
 * any work, or a large job whose approach is open, is plan.
 */
const LONG_PROMPTS: Array<{ text: string; expect: Mode }> = [
	{
		text: "새 세션을 열고 첫 메시지를 길게 쓰면 사이드바의 세션 제목이 한참 동안 'New session'으로 남아 있어. 짧은 메시지는 바로 제목이 붙는데 300자가 넘는 메시지는 첫 답이 끝날 때까지 안 바뀌어. 로그를 보면 auto-title이 요청은 보내는데 응답이 늦게 오는 것 같아. 제목 생성 쪽에서 긴 메시지를 어떻게 자르는지 보고, 원인 찾아서 고쳐줘. 고친 다음에는 관련 테스트도 하나 추가해줘.",
		expect: "none",
	},
	{
		text: "작업 보드의 '하위 세션' 줄마다 그 세션이 쓴 비용을 오른쪽에 보여줘. 구독 계정이면 '≈ $0.25'처럼 추정치 표시를 붙이고, 종량제면 그냥 '$0.25'로. 툴팁에는 모델 이름이랑 '구독, 청구되지 않음' 같은 설명을 넣고. 데이터는 이미 main이 review push로 보내주는 usage 필드에 있으니까 그걸 쓰면 돼. 한 줄에 다 들어가야 하고 폭이 좁으면 비용 대신 제목이 먼저 잘리게 해줘. 한국어/영어 문자열 둘 다 추가하고 컴포넌트 테스트도 붙여줘.",
		expect: "none",
	},
	{
		text: "Windows에서 앱을 업데이트하고 나면 터미널 패널이 비어 있고 아무 입력도 안 받아. 다시 열면 'PtySession failed to spawn: The system cannot find the file specified (os error 2)' 오류가 나와. 업데이트 전에는 잘 됐고, 셸 설정은 Git Bash야. 아마 업데이트 후에 경로가 바뀌어서 셸 경로를 못 찾는 것 같은데, 터미널 서비스가 셸을 어디서 찾는지 확인해서 고쳐줘.",
		expect: "none",
	},
	{
		text: "When I paste a long stack trace into the composer and press Enter, the message is sent but the transcript shows it as one huge line with no wrapping, and the page scrolls sideways. Here is what I see:\n\nTypeError: Cannot read properties of undefined (reading 'map')\n    at renderRows (TranscriptList.tsx:118:23)\n    at ChatStream (ChatStream.tsx:402:11)\n    at renderWithHooks (react-dom.development.js:16305:18)\n\nIt should wrap like any other text and keep the code-looking lines monospace. Please fix the user bubble's styling so long unbroken lines wrap, and add a test for it.",
		expect: "none",
	},
	{
		text: "I'd like the session picker to support fuzzy search over titles and first messages. Right now it only matches the exact substring of the title, so searching 'auth bug' doesn't find 'Fix login bug in auth flow'. Use the same pathMatcher we use for @ mentions (word starts, CamelCase, Hangul initials), rank title matches above first-message matches, and highlight the matched characters in the row. Keep the keyboard navigation as it is. Add unit tests for the ranking.",
		expect: "none",
	},
	{
		text: "Some background first: our release workflow builds out/ once and every packaging job downloads it, and the mac job runs @smoke specs after packaging. Lately the mac job takes about 9 minutes and most of it is the smoke run, because each spec launches a fresh app and two of them wait on fixed 5 second timeouts. Please replace those two fixed waits in e2e/desktop-surfaces.e2e.ts and e2e/window-theme.e2e.ts with waits on the actual events they need, then run both specs to confirm they still pass.",
		expect: "none",
	},
	{
		// The reported case, verbatim from a real session (it went to Plan).
		text: "docs/진행.md와 docs/설계/홈페이지.md 읽고, 홈페이지 기술 결정(ADR)부터 작성한 뒤 apps/homepage 뼈대 만들어줘. Higgsfield MCP 연결도 확인해줘.",
		expect: "none",
	},
	{
		text: "src/main/tray.ts 읽고 트레이 메뉴에 '최근 세션' 하위 메뉴 추가해줘. 최근 5개를 보여주고, 누르면 그 세션이 열리게. 세션이 없으면 메뉴를 비활성화하고, 한국어/영어 라벨 둘 다 넣고 단위 테스트도 추가해줘.",
		expect: "none",
	},
	{
		text: "apps/landing에 Next.js로 랜딩 페이지 만들어줘. 히어로, 기능 소개 세 개, 가격표, FAQ 섹션을 넣고 디자인은 docs/brand.md의 색과 글꼴을 따라줘. 모바일에서도 깨지지 않게 하고, Vercel 배포 설정 파일까지 추가해줘.",
		expect: "none",
	},
	{
		text: "Add a CSV export button to the reports page. It should export the rows currently shown after filters, use the column headers as displayed, stream the file when there are more than 10,000 rows, and show a toast when the download is ready. Put the export logic in its own module and add tests for the filtering and the header row.",
		expect: "none",
	},
	{
		text: "결제 모듈을 전부 새로 짜야 할 것 같아. 지금은 Stripe 호출이 컨트롤러 여기저기 흩어져 있고, 환불이랑 구독 갱신 로직이 서로 다른 데서 중복되고 있어. 바로 코드 고치지 말고, 먼저 어떤 구조로 나눌지 계획을 세워서 보여줘. 내가 계획을 보고 괜찮으면 그때 진행하자.",
		expect: "plan",
	},
	{
		text: "We need to move the whole app from our hand-rolled REST client to GraphQL across every service: the web app, the mobile client and the three backend services. I'm not sure yet how to stage it or whether to run both side by side for a while, so work out an approach and a migration order before changing any code.",
		expect: "plan",
	},
];

const PROBE = `
import { methods } from "./modes/auto-mode";
import { AUTO_MODE_INSTRUCTIONS, autoModeCriteria } from "./modes/auto-mode-core";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = [];
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const prompts = JSON.parse(process.env.AM_PROMPTS);
   const { resolveJudge, sharedJudgmentCache } = await import("@oh-my-pi/pi-coding-agent/judgment");
   const { preprocessTinyMessage } = await import("@oh-my-pi/pi-coding-agent/tiny/message-preproc");
   for (const message of prompts) {
    const started = Date.now();
    const decision = await methods["modes.auto_mode_decide"]({ message }, env);
    const wallMs = Date.now() - started;
    // The same question again, answered from the shared cache the decision filled: the judge's probabilities.
    let probabilities = null;
    try {
     const judge = await resolveJudge({ settings: session.settings, registry: session.modelRegistry, sessionModel: session.model, sessionId: session.sessionId, metadataResolver: p => session.agent.metadataForProvider(p), purpose: "auto-mode", cache: sharedJudgmentCache(), telemetry: session.agent.telemetry });
     const result = await judge.judge({ state: { request: preprocessTinyMessage(message) }, questions: { mode: { type: "choice", instructions: AUTO_MODE_INSTRUCTIONS, criteria: autoModeCriteria(true) } } });
     probabilities = result.answers.mode.probabilities ?? null;
    } catch {}
    out.push({ message, decision, wallMs, probabilities });
   }
   console.error("AM_REAL=" + JSON.stringify(out));
  } catch (err) {
   console.error("AM_REAL_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Row {
	message: string;
	decision: {
		mode: string;
		reason?: string;
		latencyMs: number;
		model?: string;
		objective?: string;
		tokens?: { input: number; output: number };
		costUsd?: number;
	};
	wallMs: number;
	probabilities: Record<string, number> | null;
}

function decideAll(prompts: string[]): Row[] {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-am-real-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		writeFileSync(join(isolated, "bridge", "am-real.ts"), PROBE);
		copyFileSync(join(agentDir, "config.yml"), join(isolated, "config.yml"));
		copyFileSync(join(agentDir, "agent.db"), join(isolated, "agent.db"));
		const project = join(isolated, "project");
		mkdirSync(project);
		const result = spawnSync(
			omp,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(isolated, "bridge", "am-real.ts"),
			],
			{
				cwd: project,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: isolated,
					PI_CONFIG_DIR: isolated,
					AM_PROMPTS: JSON.stringify(prompts),
				},
				encoding: "utf8",
				timeout: 180_000,
				maxBuffer: 4 * 1024 * 1024,
				input: "",
			},
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("AM_REAL="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^AM_REAL=/);
		const rows = JSON.parse(line?.slice("AM_REAL=".length) ?? "[]") as Row[];
		for (const row of rows) {
			console.log(
				`AUTO_MODE_REAL ${row.decision.mode.padEnd(4)} ${String(row.decision.reason ?? "").padEnd(15)} ${row.decision.latencyMs} ms (wall ${row.wallMs} ms) ${row.decision.model ?? "-"} ${JSON.stringify(row.probabilities)} $${row.decision.costUsd ?? "-"} :: ${row.message.slice(0, 80).replace(/\s+/g, " ")}`,
			);
		}
		expect(rows).toHaveLength(prompts.length);
		return rows;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

function expectIntended(rows: Row[], wanted: Array<Mode | undefined>): void {
	// A decision that timed out is "none" by design (a cold first request often needs more than the deadline); the
	// rest must be what the product intends.
	for (const [index, row] of rows.entries()) {
		const mode = wanted[index];
		if (mode && row.decision.reason !== "timeout") expect(row.decision.mode, row.message).toBe(mode);
		expect(row.wallMs).toBeLessThan(3500);
	}
	expect(rows.filter(row => row.decision.reason === "timeout").length).toBeLessThanOrEqual(3);
}

describe.skipIf(!enabled)("automatic mode choice on the real small model", () => {
	it("decides six prompts in time", () => {
		const rows = decideAll(PROMPTS.map(p => p.text));
		expectIntended(
			rows,
			PROMPTS.map(p => p.expect),
		);
	}, 200_000);

	it("leaves a long, concrete first message alone and plans only what asks for a plan", () => {
		const rows = decideAll(LONG_PROMPTS.map(p => p.text));
		const plans = rows.filter((row, index) => row.decision.mode === "plan" && LONG_PROMPTS[index]?.expect === "none");
		console.log(
			`AUTO_MODE_REAL_LONG plan on concrete requests: ${plans.length}/${LONG_PROMPTS.filter(p => p.expect === "none").length}`,
		);
		expectIntended(
			rows,
			LONG_PROMPTS.map(p => p.expect),
		);
	}, 200_000);
});
