/**
 * What the bundled stats server answers on `stats:fetch` (Insights › Stats › All sessions): every path the ten
 * sections and the sync action read, in the wire shapes of `src/shared/stats-types.ts`.
 */
import type {
	AgentTypeRow,
	CostPoint,
	CostsData,
	ErrorRow,
	FolderRow,
	FrustrationData,
	GainData,
	LiveSyncStatus,
	ModelRow,
	ModelsData,
	OverviewData,
	ProviderRow,
	ProvidersData,
	ProviderWindowsData,
	RequestDetail,
	RequestPage,
	RequestRow,
	TimePoint,
	ToolRow,
	ToolsData,
} from "../../shared/stats-types";

const NOW = Date.now();
const HOUR = 3_600_000;
const HOURS = 24;

const MODELS = [
	{ model: "claude-sonnet-5-5", provider: "anthropic", share: 0.46, tps: 74 },
	{ model: "claude-opus-4-6", provider: "anthropic", share: 0.22, tps: 41 },
	{ model: "gpt-5.2-codex", provider: "openai-codex", share: 0.2, tps: 88 },
	{ model: "gemini-3-flash", provider: "google-gemini-cli", share: 0.12, tps: 131 },
];
const TOTAL_REQUESTS = 1234;
const FAILED_REQUESTS = 34;

const timeSeries: TimePoint[] = Array.from({ length: HOURS }, (_, index) => ({
	timestamp: NOW - (HOURS - index) * HOUR,
	requests: 20 + ((index * 7) % 30),
	errors: index % 5,
	tokens: 20_000 + index * 500,
	cost: 0.3 + (index % 4) / 10,
}));

const AGENT_TYPES = ["main", "task", "explore", "reviewer", "advisor"];
const byAgentType: AgentTypeRow[] = AGENT_TYPES.map((agentType, index) => ({
	agentType,
	totalRequests: 400 - index * 60,
	totalInputTokens: 200_000 - index * 30_000,
	totalOutputTokens: 50_000 - index * 8_000,
	totalCacheReadTokens: 120_000 - index * 20_000,
	totalCacheWriteTokens: 12_000 - index * 2_000,
	totalCost: 5 - index,
}));

const OVERVIEW: OverviewData = {
	overall: {
		totalRequests: TOTAL_REQUESTS,
		successfulRequests: TOTAL_REQUESTS - FAILED_REQUESTS,
		failedRequests: FAILED_REQUESTS,
		errorRate: FAILED_REQUESTS / TOTAL_REQUESTS,
		totalInputTokens: 500_000,
		totalOutputTokens: 120_000,
		totalCacheReadTokens: 300_000,
		totalCacheWriteTokens: 40_000,
		cacheRate: 0.37,
		totalCost: 12.5,
		avgDuration: 1800,
		avgTtft: 400,
		avgTokensPerSecond: 72,
	},
	byAgentType,
	timeSeries,
};

const byModel: ModelRow[] = MODELS.map(({ model, provider, share, tps }, index) => ({
	model,
	provider,
	totalRequests: Math.round(TOTAL_REQUESTS * share),
	failedRequests: 14 - index * 3,
	errorRate: (14 - index * 3) / Math.round(TOTAL_REQUESTS * share),
	totalInputTokens: Math.round(500_000 * share),
	totalOutputTokens: Math.round(120_000 * share),
	totalCacheReadTokens: Math.round(300_000 * share),
	totalCacheWriteTokens: Math.round(40_000 * share),
	cacheRate: 0.42 - index * 0.07,
	totalCost: Math.round(12.5 * share * 100) / 100,
	avgDuration: 1400 + index * 450,
	avgTtft: 320 + index * 90,
	avgTokensPerSecond: tps,
}));

const MODELS_DATA: ModelsData = {
	byModel,
	modelSeries: MODELS.flatMap(({ model, provider, share }) =>
		timeSeries.map(point => ({
			timestamp: point.timestamp,
			model,
			provider,
			requests: Math.max(1, Math.round(point.requests * share)),
		})),
	),
	modelPerformanceSeries: MODELS.flatMap(({ model, provider, share, tps }) =>
		timeSeries.map((point, index) => ({
			timestamp: point.timestamp,
			model,
			provider,
			requests: Math.max(1, Math.round(point.requests * share)),
			avgTtft: 300 + ((index * 37) % 200),
			avgTokensPerSecond: tps + ((index * 5) % 12),
		})),
	),
};

const costSeries: CostPoint[] = MODELS.flatMap(({ model, provider, share }) =>
	timeSeries.map(point => {
		const cost = Math.round(point.cost * share * 1000) / 1000;
		return {
			timestamp: point.timestamp,
			model,
			provider,
			cost,
			costInput: cost * 0.3,
			costOutput: cost * 0.5,
			costCacheRead: cost * 0.15,
			costCacheWrite: cost * 0.05,
			requests: Math.max(1, Math.round(point.requests * share)),
		};
	}),
);
const COSTS: CostsData = { costSeries };

const TOOL_NAMES: [string, number, number][] = [
	["bash", 412, 21],
	["read", 366, 3],
	["edit", 248, 9],
	["grep", 190, 1],
	["find", 96, 0],
	["write", 74, 2],
	["task", 58, 4],
	["web_search", 31, 1],
];
const TOOL_CALLS = TOOL_NAMES.reduce((sum, [, calls]) => sum + calls, 0);
const byTool: ToolRow[] = TOOL_NAMES.map(([tool, calls, errors], index) => ({
	tool,
	calls,
	errors,
	argsChars: calls * 180,
	resultChars: calls * (900 - index * 80),
	totalTokensShare: calls / TOOL_CALLS,
	outputTokensShare: (calls / TOOL_CALLS) * 0.8,
	costShare: calls / TOOL_CALLS,
	lastUsed: NOW - index * 17 * 60_000,
}));
const TOOLS: ToolsData = {
	byTool,
	byToolModel: [],
	series: TOOL_NAMES.slice(0, 4).flatMap(([tool, calls]) =>
		timeSeries.map((point, index) => ({
			timestamp: point.timestamp,
			tool,
			calls: Math.round(calls / HOURS) + (index % 4),
			errors: index % 9 === 0 ? 1 : 0,
		})),
	),
};

const providerRows: ProviderRow[] = [
	{ provider: "anthropic", models: 2, share: 0.68 },
	{ provider: "openai-codex", models: 1, share: 0.2 },
	{ provider: "google-gemini-cli", models: 1, share: 0.12 },
].map(({ provider, models, share }) => ({
	provider,
	totalRequests: Math.round(TOTAL_REQUESTS * share),
	failedRequests: Math.round(FAILED_REQUESTS * share),
	models,
	totalInputTokens: Math.round(500_000 * share),
	totalOutputTokens: Math.round(120_000 * share),
	totalCacheReadTokens: Math.round(300_000 * share),
	totalCacheWriteTokens: Math.round(40_000 * share),
	totalTokens: Math.round(960_000 * share),
	totalCost: Math.round(12.5 * share * 100) / 100,
	avgTokensPerSecond: provider === "google-gemini-cli" ? 131 : provider === "openai-codex" ? 88 : 62,
}));
const PROVIDERS_DATA: ProvidersData = {
	providers: providerRows,
	hourly: providerRows.flatMap(row =>
		Array.from({ length: HOURS }, (_, hour) => ({
			provider: row.provider,
			hour,
			totalTokens: Math.round((row.totalTokens / HOURS) * (hour >= 9 && hour <= 19 ? 1.6 : 0.4)),
			outputTokens: Math.round((row.totalOutputTokens / HOURS) * (hour >= 9 && hour <= 19 ? 1.6 : 0.4)),
			requests: Math.round((row.totalRequests / HOURS) * (hour >= 9 && hour <= 19 ? 1.6 : 0.4)),
		})),
	),
	series: [],
};

const PROVIDER_WINDOWS: ProviderWindowsData = {
	windowInsights: [
		{
			provider: "anthropic",
			windowKey: "5h",
			windowLabel: "5-hour window",
			accounts: 2,
			cycles: 14,
			fractionConsumed: 0.63,
			estTokensPerWindow: 4_200_000,
			peakConcurrentFraction: 0.81,
			idealAccounts: 3,
			exhaustedEvents: 2,
		},
		{
			provider: "openai-codex",
			windowKey: "7d",
			windowLabel: "Weekly window",
			accounts: 1,
			cycles: 3,
			fractionConsumed: 0.34,
			estTokensPerWindow: 18_000_000,
			peakConcurrentFraction: 0.4,
			idealAccounts: 1,
			exhaustedEvents: 0,
		},
	],
};

const FOLDERS = [
	"/Users/dev/projects/ompdesk",
	"/Users/dev/projects/ompdesk-web",
	"/Users/dev/projects/infra",
	"/Users/dev/scratch/stats-probe",
];
const ERROR_MESSAGES = [
	"529 overloaded: please retry later",
	"Request timed out after 120s",
	"context_length_exceeded: prompt is too long",
	"401 invalid x-api-key",
];
const ERRORS: ErrorRow[] = Array.from({ length: 8 }, (_, index) => ({
	id: index + 1,
	entryId: `err-${index}`,
	sessionFile: `${FOLDERS[index % FOLDERS.length]}/.omp/sessions/s${index}.jsonl`,
	folder: FOLDERS[index % FOLDERS.length] ?? "",
	model: MODELS[index % MODELS.length]?.model ?? "",
	provider: MODELS[index % MODELS.length]?.provider ?? "",
	timestamp: NOW - (index + 1) * 47 * 60_000,
	stopReason: index % 4 === 1 ? "aborted" : "error",
	errorMessage: ERROR_MESSAGES[index % ERROR_MESSAGES.length] ?? null,
	usage: { totalTokens: 4_000 + index * 1_300 },
}));

const FOLDER_ROWS: FolderRow[] = FOLDERS.map((folder, index) => {
	const requests = 620 - index * 150;
	const failed = 18 - index * 4;
	return {
		folder,
		totalRequests: requests,
		failedRequests: Math.max(failed, 0),
		errorRate: Math.max(failed, 0) / requests,
		totalInputTokens: 260_000 - index * 60_000,
		totalOutputTokens: 62_000 - index * 14_000,
		totalCacheReadTokens: 150_000 - index * 35_000,
		totalCacheWriteTokens: 20_000 - index * 4_000,
		totalCost: 6.4 - index * 1.5,
		avgDuration: 1700 + index * 300,
		avgTokensPerSecond: 70 - index * 6,
	};
});

const GAIN: GainData = {
	overall: {
		savedTokens: 184_000,
		savedBytes: 736_000,
		hits: 212,
		outputBytes: 410_000,
		originalBytes: 1_146_000,
		reductionPercent: 64.2,
	},
	bySource: {
		snapcompact: {
			savedTokens: 121_000,
			savedBytes: 484_000,
			hits: 143,
			outputBytes: 260_000,
			originalBytes: 744_000,
			reductionPercent: 65,
		},
		dedupe: {
			savedTokens: 63_000,
			savedBytes: 252_000,
			hits: 69,
			outputBytes: 150_000,
			originalBytes: 402_000,
			reductionPercent: 62.7,
		},
	},
	timeSeries: Array.from({ length: 14 }, (_, index) => {
		const day = new Date(NOW - (13 - index) * 24 * HOUR);
		return {
			date: day.toISOString().slice(0, 10),
			snapcompact: 6_000 + ((index * 1_900) % 9_000),
			total: 10_000 + ((index * 2_700) % 12_000),
		};
	}),
	project: null,
	projects: FOLDERS,
};

const FRUSTRATION: FrustrationData = {
	overall: { messages: 842, judged: 310, annoyed: 24, atAssistant: 17, angry: 3 },
	byModel: MODELS.map(({ model }, index) => ({
		key: model,
		label: model,
		models: [model],
		messages: 400 - index * 90,
		judged: 150 - index * 30,
		annoyed: 12 - index * 3,
		atAssistant: 9 - index * 2,
		angry: Math.max(2 - index, 0),
	})),
};

const requestRows: RequestRow[] = Array.from({ length: 24 }, (_, index) => {
	const model = MODELS[index % MODELS.length];
	const failed = index % 9 === 4;
	return {
		id: 1000 - index,
		entryId: `req-${index}`,
		sessionFile: `${FOLDERS[index % FOLDERS.length]}/.omp/sessions/s${index % 5}.jsonl`,
		folder: FOLDERS[index % FOLDERS.length] ?? "",
		model: model?.model ?? "",
		provider: model?.provider ?? "",
		api: model?.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
		timestamp: NOW - index * 11 * 60_000,
		duration: failed ? 120_000 : 1_200 + ((index * 331) % 4_000),
		ttft: failed ? null : 280 + ((index * 53) % 500),
		stopReason: failed ? "error" : index % 3 === 0 ? "toolUse" : "stop",
		errorMessage: failed ? "529 overloaded: please retry later" : null,
		usage: {
			input: 6_000 + index * 450,
			output: 400 + ((index * 170) % 1_800),
			cacheRead: 22_000 + index * 600,
			cacheWrite: index % 4 === 0 ? 3_000 : 0,
			totalTokens: 29_000 + index * 1_200,
			cost: { total: 0.04 + (index % 6) / 50 },
		},
	};
});
const REQUESTS: RequestPage = { rows: requestRows, total: requestRows.length, nextCursor: null, snapshotAt: NOW };

const SYNC_BASELINE: LiveSyncStatus = {
	phase: "idle",
	current: 0,
	total: 0,
	processed: 0,
	lastSyncedAt: NOW - 5 * 60_000,
	error: null,
};

/**
 * The reply for one `stats:fetch` path. `/api/sync` answers the status before the sync and `/api/status` the one
 * after it (a later `lastSyncedAt`), so Sync completes at once.
 */
export function statsAnswer(path: string): unknown {
	switch (path) {
		case "/api/stats/overview":
			return OVERVIEW;
		case "/api/stats/model-dashboard":
			return MODELS_DATA;
		case "/api/stats/costs":
			return COSTS;
		case "/api/stats/tools":
			return TOOLS;
		case "/api/stats/providers":
			return PROVIDERS_DATA;
		case "/api/stats/provider-windows":
			return PROVIDER_WINDOWS;
		case "/api/stats/errors":
			return ERRORS;
		case "/api/stats/folders":
			return FOLDER_ROWS;
		case "/api/stats/gain":
			return GAIN;
		case "/api/stats/frustration":
			return FRUSTRATION;
		case "/api/stats/requests":
			return REQUESTS;
		case "/api/sync":
			return { sync: SYNC_BASELINE };
		case "/api/status":
			return { sync: { ...SYNC_BASELINE, processed: 1_284, total: 96, lastSyncedAt: NOW } };
		default: {
			const id = /^\/api\/request\/(\d+)$/.exec(path)?.[1];
			const row = requestRows.find(entry => String(entry.id) === id);
			if (!row) return undefined;
			const detail: RequestDetail = {
				...row,
				messages: [{ role: "user", content: [{ type: "text", text: "Fix the flaky sidebar test" }] }],
				output: { role: "assistant", content: [{ type: "text", text: "Reproducing the flake with --repeat 10." }] },
			};
			return detail;
		}
	}
}
