/**
 * Wire types for the bundled stats dashboard HTTP API (`packages/stats/src/server.ts`).
 * Hand-written like `rpc-types.ts` — no runtime dependency on @oh-my-pi/pi-stats —
 * and checked against the server's own types by `scripts/check-protocol.ts`.
 * Each type declares only the fields the GUI reads.
 */

// GET /api/stats/overview

export interface TimePoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

export interface AgentTypeRow {
	agentType: string;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

export interface OverviewData {
	overall: {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		errorRate: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		cacheRate: number;
		totalCost: number;
		avgDuration: number | null;
		avgTtft: number | null;
		avgTokensPerSecond: number | null;
	};
	byAgentType: AgentTypeRow[];
	timeSeries: TimePoint[];
}

// GET /api/stats/model-dashboard

export interface ModelRow {
	model: string;
	provider: string;
	totalRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

export interface ModelSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

export interface PerformancePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

export interface ModelsData {
	byModel: ModelRow[];
	modelSeries: ModelSeriesPoint[];
	modelPerformanceSeries: PerformancePoint[];
}

// GET /api/stats/costs

export interface CostPoint {
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

export interface CostsData {
	costSeries: CostPoint[];
}

// GET /api/stats/tools

export interface ToolRow {
	tool: string;
	calls: number;
	errors: number;
	argsChars: number;
	resultChars: number;
	totalTokensShare: number;
	outputTokensShare: number;
	costShare: number;
	lastUsed: number;
}

export interface ToolsData {
	byTool: ToolRow[];
	byToolModel: unknown[];
	series: { timestamp: number; tool: string; calls: number; errors: number }[];
}

// GET /api/stats/providers

export interface ProviderRow {
	provider: string;
	totalRequests: number;
	failedRequests: number;
	models: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCost: number;
	avgTokensPerSecond: number | null;
}

export interface HourlyPoint {
	provider: string;
	hour: number;
	totalTokens: number;
	outputTokens: number;
	requests: number;
}

export interface ProvidersData {
	providers: ProviderRow[];
	hourly: HourlyPoint[];
	series: unknown[];
}

// GET /api/stats/provider-windows — separate because snapshots may come over the network

export interface WindowInsight {
	provider: string;
	windowKey: string;
	windowLabel: string;
	accounts: number;
	cycles: number;
	fractionConsumed: number;
	estTokensPerWindow: number | null;
	peakConcurrentFraction: number;
	idealAccounts: number;
	exhaustedEvents: number;
}

export interface ProviderWindowsData {
	windowInsights: WindowInsight[];
}

// GET /api/stats/errors (bare array)

export interface ErrorRow {
	id?: number;
	entryId?: string;
	sessionFile: string;
	folder: string;
	model: string;
	provider: string;
	timestamp: number;
	stopReason: string;
	errorMessage: string | null;
	usage: { totalTokens: number };
}

// GET /api/stats/folders (bare array)

export interface FolderRow {
	folder: string;
	totalRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	avgDuration: number | null;
	avgTokensPerSecond: number | null;
}

// GET /api/stats/gain

export interface SourceTotals {
	savedTokens: number;
	savedBytes: number;
	hits: number;
	outputBytes: number;
	originalBytes: number;
	reductionPercent: number | null;
}

export interface GainPoint {
	date: string;
	snapcompact: number;
	total: number;
}

export interface GainData {
	overall: SourceTotals;
	bySource: Record<string, SourceTotals>;
	timeSeries: GainPoint[];
	project: string | null;
	projects: string[];
}

// GET /api/stats/requests, GET /api/request/:id

export interface RequestRow {
	id?: number;
	entryId: string;
	sessionFile: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
}

export interface RequestPage {
	rows: RequestRow[];
	total: number;
	nextCursor: string | null;
	snapshotAt: number;
}

export interface RequestDetail extends RequestRow {
	messages: unknown[];
	output: unknown;
}

// GET /api/stats/frustration

export interface FrustrationCounts {
	messages: number;
	judged: number;
	annoyed: number;
	atAssistant: number;
	angry: number;
}

export interface FrustrationModelRow extends FrustrationCounts {
	key: string;
	label: string;
	models: string[];
}

export interface FrustrationData {
	overall: FrustrationCounts;
	byModel: FrustrationModelRow[];
}

// GET /api/status, POST /api/sync

export interface LiveSyncStatus {
	phase: "idle" | "syncing" | "error";
	current: number;
	total: number;
	processed: number;
	lastSyncedAt: number | null;
	error: string | null;
}

export interface LiveStatus {
	version: number;
	sync: LiveSyncStatus;
}
