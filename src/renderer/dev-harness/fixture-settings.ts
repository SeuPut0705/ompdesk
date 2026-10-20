/**
 * Fixture answers for the pages behind Settings (model roles, plugins, updates), so the dev harness opens every
 * section with stock-shaped data instead of the transport's `{}`.
 */

import type { ModelSetupFacts, SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";
import type { RemoteState } from "../../shared/ipc-types";
import { type MobileWebState, type WebBlockedInfo, type WebDeviceInfo, webDeviceTier } from "../../shared/mobile-web";
import type { ModelRoleCandidate, ModelRoleEntry } from "../../shared/rpc-types";
import type { SchedulesState } from "../../shared/schedules";
import type { SetupItemState, SetupState } from "../../shared/setup";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";

const CANDIDATES: ModelRoleCandidate[] = [
	{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", kind: "chat" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", kind: "chat" },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", kind: "chat" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5", kind: "chat" },
	{ provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini", kind: "chat" },
	{ provider: "openrouter", id: "deepseek-v3", name: "DeepSeek V3", kind: "chat" },
	{ provider: "ollama", id: "qwen3", name: "Qwen3 8B", kind: "chat" },
];

const IMAGE_CANDIDATES: ModelRoleCandidate[] = [
	{ provider: "openai", id: "gpt-image-1", name: "GPT Image 1", kind: "image" },
];

const catalogName = (selector: string): string =>
	[...CANDIDATES, ...IMAGE_CANDIDATES].find(entry => `${entry.provider}/${entry.id}` === selector)?.name ?? selector;

const role = (
	id: string,
	name: string,
	model: string | undefined,
	section: ModelRoleEntry["section"] = "chat",
): ModelRoleEntry => ({
	id,
	name,
	section,
	model,
	source: model ? "settings" : "default",
	// What stock's resolution answers: a model of the role's own pool, by its catalog name.
	effective: model
		? { model, name: catalogName(model), source: "configured" }
		: section === "kind"
			? { model: "openai/gpt-image-1", name: catalogName("openai/gpt-image-1"), source: "fallback" }
			: {
					model: "anthropic/claude-sonnet-4-5",
					name: catalogName("anthropic/claude-sonnet-4-5"),
					source: "fallback",
					via: "default",
				},
	candidates: section === "kind" ? IMAGE_CANDIDATES : CANDIDATES,
});

export const MODEL_ROLES = {
	roles: [
		role("default", "Default", "anthropic/claude-sonnet-4-5"),
		role("slow", "Thinking", undefined),
		role("smol", "Fast", "anthropic/claude-haiku-4-5"),
		role("plan", "Architect", undefined),
		role("task", "Subtask", undefined),
		role("advisor", "Advisor", undefined),
		role("commit", "Commit", undefined),
		role("tiny", "Tiny", undefined),
		role("vision", "Vision", undefined),
		role("image", "Image generation", undefined, "kind"),
		// OMPdesk's own role: empty, it follows the advisor (which follows Thinking here).
		{
			...role("review", "Review", undefined),
			origin: "ompdesk",
			defaults: ["@review", "@advisor", "@slow", "@task"],
			effective: {
				model: "anthropic/claude-sonnet-4-5",
				name: catalogName("anthropic/claude-sonnet-4-5"),
				source: "fallback",
				via: "advisor",
			},
		},
	],
};

/** The model setup's facts (`get_model_setup_facts`): two subscriptions, one API-key aggregator, one local runtime. */
export const MODEL_SETUP_FACTS: ModelSetupFacts = {
	providers: {
		anthropic: { billing: "subscription", basis: "oauth" },
		openai: { billing: "subscription", basis: "oauth" },
		openrouter: { billing: "metered", basis: "api-key" },
		ollama: { billing: "free", basis: "local-keyless" },
	},
	models: Object.fromEntries(
		[
			[
				"anthropic/claude-opus-4-5",
				{ int: 80, contextWindow: 200_000, inputPrice: 5, outputPrice: 25, family: "claude" },
			],
			[
				"anthropic/claude-sonnet-4-5",
				{ int: 70, contextWindow: 1_000_000, inputPrice: 3, outputPrice: 15, family: "claude" },
			],
			[
				"anthropic/claude-haiku-4-5",
				{ int: 55, contextWindow: 200_000, inputPrice: 1, outputPrice: 5, family: "claude" },
			],
			["openai/gpt-5", { int: 78, contextWindow: 400_000, inputPrice: 1.25, outputPrice: 10, family: "gpt" }],
			["openai/gpt-5-mini", { int: 58, contextWindow: 400_000, inputPrice: 0.25, outputPrice: 2, family: "gpt" }],
			[
				"openrouter/deepseek-v3",
				{ int: 62, contextWindow: 128_000, inputPrice: 0.3, outputPrice: 1.2, family: "deepseek" },
			],
			["ollama/qwen3", { int: 35, contextWindow: 32_000, inputPrice: 0, outputPrice: 0, family: "qwen" }],
			["openai/gpt-image-1", { family: "gpt" }],
		].map(([selector, facts]) => {
			const [provider, ...rest] = (selector as string).split("/");
			const candidate = [...CANDIDATES, ...IMAGE_CANDIDATES].find(
				entry => `${entry.provider}/${entry.id}` === selector,
			);
			return [
				selector,
				{
					provider,
					id: rest.join("/"),
					name: candidate?.name ?? selector,
					kind: candidate?.kind ?? "chat",
					image: provider === "anthropic" || provider === "openai",
					...(facts as object),
				},
			];
		}),
	),
	// The values config.yml holds; smol was set by hand, so the proposal keeps it unticked.
	roles: {
		default: { persisted: "anthropic/claude-sonnet-4-5" },
		smol: { persisted: "anthropic/claude-haiku-4-5" },
	},
	judgePins: [],
};

/**
 * `get_session_spend`: the spend of a real session's journal (a read-only copy, 20 Oct 2026: its OpenRouter row is
 * the judge's `find` calls, its Anthropic rows a subscription's replies), plus the billing classes above.
 */
export const SESSION_SPEND: SessionSpend = {
	providers: {
		anthropic: { billing: "subscription", cost: 35.627, today: 35.627 },
		openrouter: { billing: "metered", cost: 0.00142, today: 0.00142 },
	},
	billing: Object.fromEntries(
		Object.entries(MODEL_SETUP_FACTS.providers).map(([provider, row]) => [provider, row.billing]),
	),
};

export const PLUGINS = { plugins: [] };
export const MARKETPLACES = { marketplaces: [] };
export const PROMPT_TEMPLATES = { templates: [] };

// ── Schedules (Settings › Schedules) ─────────────────────────────────────────────────────────────────────────
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

export const SCHEDULES_STATE: SchedulesState = {
	paused: false,
	schedules: [
		{
			id: "sched-1",
			name: "Nightly dependency audit with a long name that must wrap or truncate cleanly",
			prompt: "Check for outdated dependencies and open a summary.",
			cwd: "/Users/dev/projects/ompdesk-with-a-rather-long-folder-name",
			frequency: { kind: "daily", time: "03:00", days: [] },
			model: "anthropic/claude-sonnet-4-5",
			autoApprove: false,
			enabled: true,
			createdAt: iso(-9 * 86_400_000),
		},
		{
			id: "sched-2",
			name: "Triage",
			prompt: "Triage new issues.",
			cwd: "/Users/dev/projects/api",
			frequency: { kind: "interval", minutes: 90 },
			model: null,
			autoApprove: true,
			enabled: false,
			createdAt: iso(-3 * 86_400_000),
		},
	],
	runs: [
		{
			id: "run-1",
			scheduleId: "sched-1",
			trigger: "schedule",
			startedAt: iso(-6 * 3_600_000),
			endedAt: iso(-6 * 3_600_000 + 240_000),
			status: "succeeded",
			exitCode: 0,
			error: null,
		},
		{
			id: "run-2",
			scheduleId: "sched-2",
			trigger: "manual",
			startedAt: iso(-3_600_000),
			endedAt: iso(-3_500_000),
			status: "failed",
			exitCode: 1,
			error: "omp exited with code 1",
		},
		{
			id: "run-3",
			scheduleId: "sched-1",
			trigger: "schedule",
			startedAt: iso(-60_000),
			endedAt: null,
			status: "running",
			exitCode: null,
			error: null,
		},
	],
	nextRuns: { "sched-1": iso(5 * 3_600_000), "sched-2": null },
};

export const SCHEDULE_LOG = "Checked 41 packages.\n3 are outdated: react, vite, zod.\nOpened a summary.\n";

// ── Mobile web (Settings › Devices & connections) ────────────────────────────────────────────────────────────
export const MOBILE_WEB_STATE: MobileWebState = {
	enabled: true,
	phase: "ready",
	url: "https://studio-mac.tail1234.ts.net:47831",
	host: "studio-mac.tail1234.ts.net",
	port: 47831,
	user: "seuput@example.com",
	allowedUsers: ["seuput@example.com", "family-member-with-a-long-address@example.org"],
	confirmNewDevices: false,
	tailscale: {
		variant: "mac-standalone",
		path: "/Applications/Tailscale.app",
		version: "1.78.1",
		updateAvailable: false,
	},
	install: null,
	loginUrl: null,
	guideUrl: null,
	detail: null,
	funnelExposed: false,
	published: true,
	phones: ["iPhone 15"],
};

const WEB_DEVICE = (id: string, name: string, connected: boolean): WebDeviceInfo => ({
	id,
	name,
	userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
	tailscaleLogin: "seuput@example.com",
	createdAt: NOW - 5 * 86_400_000,
	lastSeenAt: NOW - 120_000,
	connected,
	grants: [...DEFAULT_WEB_GRANTS],
	tier: webDeviceTier(DEFAULT_WEB_GRANTS),
	limits: { requestsPerDay: 200 },
	usage: { requests: 41, tokens: 183_000 },
	blockScope: "node",
});

export const WEB_DEVICES: WebDeviceInfo[] = [
	WEB_DEVICE("web-1", "Seuput's iPhone 15 Pro Max", true),
	WEB_DEVICE("web-2", "iPad", false),
];

export const WEB_BLOCKS: WebBlockedInfo[] = [
	{
		id: "blk-1",
		scope: "node",
		name: "Unknown Android",
		tailscaleLogin: "seuput@example.com",
		blockedAt: NOW - 86_400_000,
	},
];

// ── Remote devices (Settings › Devices & connections › Share this computer) ───────────────────────────────────
export const REMOTE_STATE: RemoteState = {
	tailnet: "ready",
	host: {
		enabled: true,
		name: "Studio Mac",
		port: 47821,
		addresses: ["100.101.102.103:47821", "[fd7a:115c:a1e0::1]:47821"],
		listenError: null,
		peers: [
			{
				deviceId: "peer-1",
				name: "Work laptop",
				login: "seuput@example.com",
				online: true,
				lastSeenAt: NOW - 30_000,
				limits: { requestsPerDay: 100, tokensPerDay: 500_000 },
				usage: { requests: 12, tokens: 61_000 },
			},
		],
		keepAwake: true,
		keepingAwake: true,
		usedBy: ["Work laptop"],
		confirmNewDevices: false,
	},
	hosts: [
		{
			deviceId: "host-1",
			name: "Build server in the office closet",
			state: "online",
			platform: "linux",
			home: "/home/dev",
		},
		{ deviceId: "host-2", name: "Old desktop", state: "offline", platform: "win32" },
	],
	forgotten: [],
};

// ── Permissions, Projects, machine setup ─────────────────────────────────────────────────────────────────────
export const SECURITY_DASHBOARD = {
	enabled: false,
	modelReady: true,
	repositoryRoot: "/Users/dev/projects/ompdesk",
	scans: [],
	operations: [],
};

export const DIRECTORIES = {
	directories: [
		{ path: "/Users/dev/projects/ompdesk", primary: true },
		{ path: "/Users/dev/projects/shared-design-tokens-with-a-long-folder-name", primary: false },
	],
};

const setupItem = (id: SetupItemState["id"], required: boolean, version: string): SetupItemState => ({
	id,
	required,
	phase: "present",
	presence: { kind: "present", version, path: `/usr/local/bin/${id}` },
	method: null,
	command: null,
	location: null,
	prompt: null,
	progress: null,
	output: "",
	failure: null,
	manualCommands: [],
	manualUrl: `https://example.com/${id}`,
});

export const SETUP_STATE: SetupState = {
	platform: "darwin",
	automatic: true,
	ompReady: true,
	requiredRunning: false,
	items: [
		setupItem("bun", true, "1.3.0"),
		setupItem("git", true, "2.47.0"),
		setupItem("omp", true, "18.11.1"),
		setupItem("gh", false, "2.60.0"),
		setupItem("node", false, "22.11.0"),
		setupItem("tailscale", false, "1.78.1"),
	],
};

// ── Dialogs ───────────────────────────────────────────────────────────────────────────────────────────────────
export const RUNTIME_LOG_TAIL = [
	"2026-10-18T06:01:12Z [error] sidecar: request timed out after 30s (get_usage)",
	"2026-10-18T06:01:40Z [error] extension host: failed to read /Users/dev/projects/ompdesk/.omp/extensions/a-very-long-extension-name/index.ts",
];

export const ACTIVE_TOOLS = {
	tools: [
		{ name: "read", description: "Read files and directories", source: "builtin" },
		{ name: "write", description: "Write a file", source: "builtin" },
		{ name: "bash", description: "Run a shell command in the project", source: "builtin" },
		{ name: "web_search", description: "Search the web", source: "mcp:search" },
	],
};
