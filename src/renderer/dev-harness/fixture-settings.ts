/**
 * Fixture answers for the pages behind Settings (model roles, plugins, updates), so the dev harness opens every
 * section with stock-shaped data instead of the transport's `{}`.
 */

import type { RemoteState } from "../../shared/ipc-types";
import { type MobileWebState, type WebBlockedInfo, type WebDeviceInfo, webDeviceTier } from "../../shared/mobile-web";
import type { ModelRoleCandidate, ModelRoleEntry } from "../../shared/rpc-types";
import type { SchedulesState } from "../../shared/schedules";
import type { SetupItemState, SetupState } from "../../shared/setup";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";

const CANDIDATES: ModelRoleCandidate[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", kind: "chat" },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", kind: "chat" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5", kind: "chat" },
];

const role = (id: string, name: string, model: string | undefined): ModelRoleEntry => ({
	id,
	name,
	section: "chat",
	builtin: true,
	model,
	source: model ? "settings" : "default",
	effective: model
		? { model, name: model.split("/")[1], source: "configured" }
		: { model: "anthropic/claude-sonnet-4-5", name: "claude-sonnet-4-5", source: "fallback", via: "default" },
	candidates: CANDIDATES,
});

export const MODEL_ROLES = {
	roles: [
		role("default", "Default", "anthropic/claude-sonnet-4-5"),
		role("slow", "Slow", undefined),
		role("smol", "Smol", "anthropic/claude-haiku-4-5"),
		role("plan", "Plan", undefined),
	],
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
	host: {
		enabled: true,
		name: "Studio Mac",
		port: 47900,
		addresses: ["192.168.0.12:47900", "10.0.0.5:47900"],
		code: "482 915",
		expiresAt: NOW + 9 * 60_000,
		peers: [
			{
				deviceId: "peer-1",
				name: "Work laptop",
				online: true,
				lastSeenAt: NOW - 30_000,
				limits: { requestsPerDay: 100, tokensPerDay: 500_000 },
				usage: { requests: 12, tokens: 61_000 },
			},
		],
		keepAwake: true,
		keepingAwake: true,
		usedBy: ["Work laptop"],
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
