import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The stock-parity tool renderers (generic card, MCP, think, yield, LSP diagnostics, cfg://,
// read metadata, ast_grep, eval cells, search limits, lsp failures, wait details, prose devices)
// fed stock's result `details` through the fake omp's `fixture flow`: each step must render in
// the live work-card stage and again as its card once the run is over. The default run checks
// English on a light window; OMP_GUI_TOOL_CAPTURES=<dir> adds dark and Korean windows and a narrow
// one, and saves every stage and card there.
const OUT = process.env.OMP_GUI_TOOL_CAPTURES ?? "";

interface Shown {
	selector?: string;
	text?: string;
}

interface Step {
	id: string;
	name: string;
	args: Record<string, unknown>;
	text: string;
	details?: Record<string, unknown>;
	error?: boolean;
	/** Language-neutral evidence the renderer drew this step's details. */
	shows: Shown;
	/**
	 * What the live stage shows instead, when it differs: `calm` for a tool the stage keeps a calm
	 * line for; edits and writes show their change there and leave diagnostics to the card.
	 */
	stage?: Shown | "calm";
}

// Shapes from stock's `omp gallery` fixtures, as StockParityRenderers.test.tsx uses them.
const diagnostics = {
	server: "typescript-language-server",
	messages: [
		"src/auth.ts:12:5 [warning] [ts] 'token' is declared but never used. (6133)",
		"src/auth.ts:4:1 [error] [ts] Cannot find name 'Session'. (2304)",
	],
	summary: "1 error(s), 1 warning(s)",
	errored: true,
};

const STEPS: Step[] = [
	{
		id: "g1",
		name: "checkpoint",
		args: { goal: "trace the retry path" },
		text: '{"rewound":true,"report":{"lines":3}}',
		details: { skill: "release" },
		shows: { selector: '[role="treeitem"]', text: "rewound" },
	},
	{
		id: "m1",
		name: "mcp__rea_open_binary",
		args: { path: "/bin/ls" },
		text: '{"format":"mach-o","arch":"arm64"}',
		details: {
			serverName: "rea",
			mcpToolName: "open_binary",
			providerName: "MCP Config",
			structuredContent: { format: "mach-o" },
		},
		shows: { text: "MCP Config" },
	},
	{
		id: "k1",
		name: "think",
		args: { thoughts: "The retry loop re-reads the **config** after every failure." },
		text: "------",
		details: { recorded: true },
		shows: { selector: "strong", text: "config" },
	},
	{
		id: "y1",
		name: "yield",
		args: { data: { summary: "Two races in the flush path.", confidence: 0.8 } },
		text: "Result submitted.",
		details: { status: "success", data: { summary: "Two races in the flush path.", confidence: 0.8 } },
		shows: { selector: '[role="treeitem"]', text: "Two races in the flush path." },
	},
	{
		id: "e1",
		name: "edit",
		args: { path: "src/auth.ts" },
		text: "Updated src/auth.ts",
		details: { diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", diagnostics },
		shows: { selector: "[data-tool-diagnostics]", text: "Cannot find name 'Session'" },
		stage: { text: "const a = 2;" },
	},
	{
		id: "r1",
		name: "read",
		args: { path: "http://example.com/docs" },
		text: "# Docs",
		details: {
			kind: "url",
			url: "http://example.com/docs",
			finalUrl: "https://www.example.com/docs/",
			contentType: "text/html",
			method: "readability",
			truncated: true,
		},
		shows: { selector: "[data-read-meta]", text: "example.com" },
		// The stage shows what was read; the card heads it with the URL's metadata.
		stage: { text: "# Docs" },
	},
	{
		id: "w1",
		name: "write",
		args: { path: "bin/run.sh", content: "#!/bin/sh\necho hi" },
		text: "Wrote bin/run.sh",
		details: { madeExecutable: true, diagnostics },
		shows: { selector: "[data-tool-diagnostics]", text: "Cannot find name 'Session'" },
		stage: { text: "echo hi" },
	},
	{
		id: "c1",
		name: "write",
		args: { path: "cfg://advisor/enabled/save", content: "true" },
		text: "advisor.enabled = true (saved)",
		details: {
			cfg: {
				path: "advisor.enabled",
				save: true,
				previous: "false",
				value: "true",
				outcome: "applied",
				effective: "false",
			},
		},
		shows: { selector: "[data-tool-cfg-write]", text: "false → true" },
	},
	{
		id: "a1",
		name: "ast_grep",
		args: { pat: "useState($A)", path: "packages/tui/src/components" },
		text: "model text",
		details: {
			matchCount: 2,
			fileCount: 2,
			filesSearched: 14,
			limitReached: true,
			scopePath: "packages/tui/src/components",
			displayContent: [
				"# packages/tui/src/components/",
				"## SearchBox.tsx",
				'*18│  const [query, setQuery] = useState("");',
				'  meta: $A=""',
				"## StatusBar.tsx",
				"*27│  const [expanded, setExpanded] = useState(false);",
				"  meta: $A=false",
			].join("\n"),
		},
		shows: { text: "packages/tui/src/components/SearchBox.tsx" },
	},
	{
		id: "r2",
		name: "read",
		args: { path: "cfg://advisor" },
		text: "advisor:\n  enabled: true\n  model: smol",
		details: { cfg: { path: "advisor", count: 2, modified: 1 } },
		shows: { selector: "[data-read-meta]", text: "2" },
		stage: { text: "smol" },
	},
	{
		id: "v1",
		name: "eval",
		args: {
			cells: [
				{ language: "py", title: "load", code: "x = 1" },
				{ language: "py", title: "print", code: "print(x)" },
			],
		},
		text: "1",
		details: {
			languages: ["python"],
			jsonOutputs: [{ rows: 3 }],
			notice: "Fell back to the subprocess kernel",
			cells: [
				{
					index: 0,
					title: "load",
					code: "x = 1",
					language: "python",
					output: "",
					status: "complete",
					durationMs: 12,
				},
				{
					index: 1,
					title: "print",
					code: "print(x)",
					language: "python",
					output: "1",
					status: "error",
					exitCode: 1,
				},
			],
		},
		shows: { selector: "[data-eval-cell]", text: "print(x)" },
	},
	{
		id: "f1",
		name: "glob",
		args: { pattern: "**/*.ts" },
		text: "",
		details: { fileCount: 0, files: [], timedOut: true, missingPaths: ["vendor/"] },
		shows: { text: "vendor/" },
	},
	{
		id: "s1",
		name: "grep",
		args: { pattern: "retry" },
		text: "",
		details: {
			matchCount: 1,
			fileCount: 1,
			files: ["src/a.ts"],
			displayContent: "*3│const retry = 1;",
			missingPaths: ["gone/"],
			meta: { limits: { columnTruncated: { maxColumn: 500 } } },
		},
		shows: { text: "gone/" },
	},
	{
		id: "l1",
		name: "lsp",
		args: { action: "diagnostics", file: "src/a.ts" },
		text: "✗ src/a.ts: all language servers failed (spawn ENOENT)",
		shows: { selector: "[data-lsp-server-status]", text: "spawn ENOENT" },
	},
	{
		id: "t1",
		name: "wait",
		args: {},
		text: "1 job running.",
		details: {
			op: "wait",
			interrupted: true,
			jobs: [
				{
					id: "job_b2",
					type: "task",
					status: "running",
					label: "Migrate rate limiter",
					durationMs: 9_000,
					completionPercent: 40,
					resolvedModel: "anthropic/claude-sonnet-4-5",
				},
			],
			agents: [{ id: "Scout", parentId: "Main", ageMs: 3_000, live: true }],
		},
		shows: { selector: '[role="progressbar"]', text: "" },
		stage: "calm",
	},
	{
		id: "p1",
		name: "write",
		args: { path: "xd://report_issue", content: "read: the summary dropped the last elided span" },
		text: "Reported.",
		shows: { selector: "[data-tool-device-note]", text: "the summary dropped the last elided span" },
	},
];

interface Variant {
	name: string;
	language: "en" | "ko";
	theme: "light" | "dark";
	size: [number, number];
}

const VARIANTS: Variant[] = [
	{ name: "en-light", language: "en", theme: "light", size: [1440, 900] },
	...(OUT
		? ([
				{ name: "en-dark", language: "en", theme: "dark", size: [1440, 900] },
				{ name: "ko-light", language: "ko", theme: "light", size: [1440, 900] },
				{ name: "ko-dark", language: "ko", theme: "dark", size: [1440, 900] },
				{ name: "narrow-en-light", language: "en", theme: "light", size: [800, 640] },
			] satisfies Variant[])
		: []),
];

test.describe.configure({ mode: "parallel" });

test.beforeAll(async () => {
	if (OUT) await fs.mkdir(OUT, { recursive: true });
});

async function expectShown(scope: Locator, shown: Shown, step: Step): Promise<void> {
	const target = shown.selector ? scope.locator(shown.selector) : scope;
	const match = shown.text ? target.filter({ hasText: shown.text }) : target;
	await expect(match.first(), `${step.name} ${step.id}`).toBeVisible();
}

async function capture(target: Page | Locator, name: string): Promise<void> {
	if (!OUT) return;
	await target.screenshot({ path: path.join(OUT, `${name}.png`), scale: "css", animations: "disabled" });
}

for (const variant of VARIANTS)
	test(`tool renderers in the work stage and their cards (${variant.name})`, async () => {
		test.setTimeout(180_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `ompdesk-tools-${variant.name}-`));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: variant.language, themeName: variant.theme, firstRunComplete: true }),
		);
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		try {
			const page = await app.firstWindow();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await app.evaluate(
				({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height),
				variant.size,
			);
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active)?.tabId;
			if (!tab) throw new Error("No active tab");
			const op = async (spec: Record<string, unknown>) => {
				const response = await page.evaluate(
					([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
					[tab, `fixture:flow:${JSON.stringify(spec)}`] as const,
				);
				if (!response.success) throw new Error(`flow op ${JSON.stringify(spec)}: ${response.error}`);
			};
			const input = page.locator("textarea").first();
			await input.fill("fixture flow");
			await input.press("Enter");
			const card = page.locator(".omp-execution-group");
			await expect(card).toHaveCount(1, { timeout: 15_000 });
			const stage = card.locator(".omp-work-stage");
			for (const [index, step] of STEPS.entries()) {
				await op({ op: "call", id: step.id, name: step.name, args: step.args });
				await op({
					op: "end",
					id: step.id,
					text: step.text,
					details: step.details,
					error: step.error === true,
				});
				if (step.stage !== "calm") {
					// The stage keeps the step it just finished until the next one starts.
					await expectShown(stage, step.stage ?? step.shows, step);
					await capture(stage, `${variant.name}-stage-${String(index).padStart(2, "0")}-${step.id}-${step.name}`);
				}
			}
			await op({ op: "reply", text: "Every renderer ran." });
			await expect(card).toHaveAttribute("data-state", "complete");
			await card.locator(".omp-execution-group-header").first().click();
			const toolCards = card.locator(".omp-tool-card");
			await expect(toolCards).toHaveCount(STEPS.length);
			await page.keyboard.press("Control+o");
			for (const [index, step] of STEPS.entries()) {
				const body = toolCards.nth(index);
				await expect(body.locator(":scope > button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
				await body.scrollIntoViewIfNeeded();
				await expectShown(body, step.shows, step);
				await capture(body, `${variant.name}-card-${String(index).padStart(2, "0")}-${step.id}-${step.name}`);
			}
			// The finished run as a reader meets it.
			await card.locator(".omp-execution-group-header").first().scrollIntoViewIfNeeded();
			await capture(page, `${variant.name}-window`);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
