import type { AutopilotAction } from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { DelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import type { SessionModelOverride } from "./model-restore";
import type {
	AgentFileScope,
	ImageContent,
	MessagesPage,
	RpcCommand,
	RpcDebugParams,
	RpcMcpServerInput,
	RpcResponse,
	RpcSecurityDispositionStatus,
	RpcSecurityTargetInput,
	RpcSshHostInput,
	ThinkingLevel,
	TodoPhase,
} from "./rpc-types";

/** The session RPC surface; preload adds `commandForTab` for `window.omp.rpc`. */
export interface SessionRpcClient {
	command: RpcTransport;
	getState(): Promise<RpcResponse>;
	prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse>;
	steer(message: string, images?: ImageContent[]): Promise<RpcResponse>;
	followUp(message: string, images?: ImageContent[]): Promise<RpcResponse>;
	abort(): Promise<RpcResponse>;
	abortAndPrompt(message: string): Promise<RpcResponse>;
	/** Stop the turn the TUI Esc way: the queued user input comes back (RpcAbortAndRestoreQueueResult). */
	abortAndRestoreQueue(): Promise<RpcResponse>;
	newSession(parentSession?: string): Promise<RpcResponse>;
	switchSession(sessionPath: string, model?: SessionModelOverride): Promise<RpcResponse>;
	branch(entryId: string): Promise<RpcResponse>;
	fork(): Promise<RpcResponse>;
	eval(code: string, language?: "python" | "js" | "ruby" | "julia", excluded?: boolean): Promise<RpcResponse>;
	abortEval(): Promise<RpcResponse>;
	abortMaintenance(): Promise<RpcResponse>;
	dequeue(): Promise<RpcResponse>;
	getQueue(): Promise<RpcResponse>;
	queueEdit(queueId: string, text: string): Promise<RpcResponse>;
	queueRemove(queueId: string): Promise<RpcResponse>;
	queueMove(queueId: string, toIndex: number, toLane?: "steering" | "followUp"): Promise<RpcResponse>;
	queueClear(lane?: "steering" | "followUp"): Promise<RpcResponse>;
	setModel(provider: string, modelId: string): Promise<RpcResponse>;
	cycleModel(direction?: "forward" | "backward"): Promise<RpcResponse>;
	retry(): Promise<RpcResponse>;
	clearContext(): Promise<RpcResponse>;
	abortSubagent(agentId: string): Promise<RpcResponse>;
	reviveSubagent(agentId: string): Promise<RpcResponse>;
	steerSubagent(subagentId: string, message: string): Promise<RpcResponse>;
	writeLocalPaste(content: string): Promise<RpcResponse>;
	/** `local://…` → `{path}` in the session's local root (stock resolution through the bridge). */
	resolveLocalUrl(url: string): Promise<RpcResponse>;
	getActiveTools(): Promise<RpcResponse>;
	setPrewalk(enabled: boolean): Promise<RpcResponse>;
	fresh(): Promise<RpcResponse>;
	shakeContext(mode: "elide" | "images" | "thinking"): Promise<RpcResponse>;
	reloadPlugins(): Promise<RpcResponse>;
	setForceTool(payload: { tool: string } | { clear: true }): Promise<RpcResponse>;
	getForceTool(): Promise<RpcResponse>;
	listForeignSessions(source: "claude" | "codex"): Promise<RpcResponse>;
	importForeignSession(source: "claude" | "codex", foreignId: string): Promise<RpcResponse>;
	forkFrom(entryId: string): Promise<RpcResponse>;
	switchLeaf(entryId: string, options?: { summarize?: boolean; customInstructions?: string }): Promise<RpcResponse>;
	getCommandArgCompletions(command: string, prefix: string): Promise<RpcResponse>;
	mcpAdd(name: string, config: RpcMcpServerInput, scope?: "user" | "project"): Promise<RpcResponse>;
	mcpTest(probe: { name?: string; config?: RpcMcpServerInput }): Promise<RpcResponse>;
	mcpReauth(name: string): Promise<RpcResponse>;
	mcpReauthCancel(name: string): Promise<RpcResponse>;
	marketplaceAction(payload: {
		action: "add" | "remove" | "update" | "install" | "uninstall" | "upgrade" | "list_available";
		marketplace?: string;
		plugin?: string;
		source?: string;
	}): Promise<RpcResponse>;
	getPluginDetail(pluginId: string): Promise<RpcResponse>;
	setPluginFeatures(pluginId: string, features: string[]): Promise<RpcResponse>;
	setPluginSetting(pluginId: string, key: string, value: unknown): Promise<RpcResponse>;
	deletePluginSetting(pluginId: string, key: string): Promise<RpcResponse>;
	getDirectories(): Promise<RpcResponse>;
	addDirectory(path: string): Promise<RpcResponse>;
	removeDirectory(path: string): Promise<RpcResponse>;
	moveSession(path: string): Promise<RpcResponse>;
	getGitStatus(): Promise<RpcResponse>;
	getGitChanges(): Promise<RpcResponse>;
	/** `root`: the worktree root the last `getGitChanges` reported, which spares main a `rev-parse` per poll. */
	getGitFingerprint(root?: string): Promise<RpcResponse>;
	getGitDiff(path: string): Promise<RpcResponse>;
	worktreeCreate(
		name: string,
		options?: { baseCwd?: string; baseRef?: "HEAD" | "default"; branchPrefix?: string },
	): Promise<RpcResponse>;
	worktreeRemove(path: string, force?: boolean): Promise<RpcResponse>;
	prRepo(): Promise<RpcResponse>;
	prList(
		state?: "open" | "closed" | "merged" | "all",
		limit?: number,
		view?: "all" | "review" | "mine",
	): Promise<RpcResponse>;
	prGet(number: number): Promise<RpcResponse>;
	prDiff(number: number, path: string): Promise<RpcResponse>;
	prDraft(options?: { base?: string; head?: string }): Promise<RpcResponse>;
	prCreate(input: {
		title: string;
		body: string;
		base?: string;
		head?: string;
		draft?: boolean;
	}): Promise<RpcResponse>;
	prCheckout(number: number): Promise<RpcResponse>;
	liveStop(): Promise<RpcResponse>;
	debug(params: RpcDebugParams): Promise<RpcResponse>;
	getAvailableModels(forceRefresh?: boolean): Promise<RpcResponse>;
	setThinkingLevel(level: ThinkingLevel | "auto"): Promise<RpcResponse>;
	cycleThinkingLevel(): Promise<RpcResponse>;
	setFastMode(enabled: boolean): Promise<RpcResponse>;
	setSlowMode(enabled: boolean): Promise<RpcResponse>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse>;
	setInterruptMode(mode: "immediate" | "wait"): Promise<RpcResponse>;
	compact(customInstructions?: string): Promise<RpcResponse>;
	setAutoCompaction(enabled: boolean): Promise<RpcResponse>;
	setAutoRetry(enabled: boolean): Promise<RpcResponse>;
	abortRetry(): Promise<RpcResponse>;
	bash(command: string, excluded?: boolean): Promise<RpcResponse>;
	abortBash(): Promise<RpcResponse>;
	getSessionStats(): Promise<RpcResponse>;
	setSessionPinned(sessionId: string, pinned: boolean): Promise<RpcResponse>;
	exportHtml(outputPath?: string): Promise<RpcResponse>;
	getBranchMessages(): Promise<RpcResponse>;
	getCopyTargets(): Promise<RpcResponse>;
	getLastLink(): Promise<RpcResponse>;
	setSessionName(name: string): Promise<RpcResponse>;
	regenerateSessionTitle(): Promise<RpcResponse>;
	autoModeDecide(message: string): Promise<RpcResponse>;
	autoModeUndo(mode: "plan" | "goal"): Promise<RpcResponse>;
	autoModeEnd(mode: "plan" | "goal"): Promise<RpcResponse>;
	setEntryLabel(entryId: string, label?: string): Promise<RpcResponse>;
	handoff(customInstructions?: string): Promise<RpcResponse>;
	getLoginProviders(): Promise<RpcResponse>;
	login(providerId: string): Promise<RpcResponse>;
	/** Ends a browser sign-in in flight; `url` is the authorization URL of its `open_url`. */
	cancelLogin(url: string): Promise<RpcResponse>;
	/** Removes one stored account; the provider stays connected while another remains. */
	logout(providerId: string, credentialId: number): Promise<RpcResponse>;
	/** Removes every stored account of the provider. */
	disconnectProvider(providerId: string): Promise<RpcResponse>;
	/** `refresh` has stock probe again any account whose report is a minute old or more (otherwise stock's cache answers). */
	getProviderAccounts(providerId: string, refresh?: boolean): Promise<RpcResponse>;
	/** Spends one saved rate-limit reset of one stored account (stock `/usage reset`). */
	redeemResetPass(providerId: string, credentialId: number, creditId?: string): Promise<RpcResponse>;
	/** `refresh` has stock probe again any provider whose report is a minute old or more (otherwise stock's cache answers). */
	getUsage(refresh?: boolean): Promise<RpcResponse>;
	getSettingsSchema(): Promise<RpcResponse>;
	getSettings(paths?: string[]): Promise<RpcResponse>;
	setSetting(path: string, value: unknown): Promise<RpcResponse>;
	getProviders(forceRefresh?: boolean): Promise<RpcResponse>;
	setPlanMode(enabled: boolean): Promise<RpcResponse>;
	getPlanMode(): Promise<RpcResponse>;
	getModelRoles(): Promise<RpcResponse>;
	setModelRole(role: string, modelId: string | null): Promise<RpcResponse>;
	/** Names a custom role (display name and description); an empty name shows the id. */
	defineModelRole(roleId: string, fields: { name?: string; description?: string }): Promise<RpcResponse>;
	/** Removes a custom role: its model, name and place in the quick-switch cycle. */
	forgetModelRole(roleId: string): Promise<RpcResponse>;
	getModelRoleMetadata(): Promise<RpcResponse>;
	/** Per-model compaction points (omp 18.8.5+; older omp answers `unsupported_omp`). */
	getCompactionPoints(): Promise<RpcResponse>;
	compactionLimits(params: { values?: unknown; key?: string; input?: string }): Promise<RpcResponse>;
	/** Stock's most-recently-used models, `provider/id` newest first: `{ selectors: string[] }`. */
	getRecentModels(): Promise<RpcResponse>;
	historyRecent(limit?: number, cwd?: string): Promise<RpcResponse>;
	historySearch(query: string, limit?: number, cwd?: string): Promise<RpcResponse>;
	historyRecord(prompt: string, cwd?: string): Promise<RpcResponse>;
	getAvailableCommands(): Promise<RpcResponse>;
	getSkills(): Promise<RpcResponse>;
	getSkillDetail(name: string): Promise<RpcResponse>;
	getAgentDefinitions(): Promise<RpcResponse>;
	getAgentDefinition(name: string): Promise<RpcResponse>;
	getAgentAuthoring(): Promise<RpcResponse>;
	readAgentFile(filePath: string): Promise<RpcResponse>;
	writeAgentFile(params: {
		scope: AgentFileScope;
		name: string;
		content: string;
		replacePath?: string;
	}): Promise<RpcResponse>;
	deleteAgentFile(filePath: string): Promise<RpcResponse>;
	installAgentTemplates(scope: AgentFileScope, names?: string[]): Promise<RpcResponse>;
	getHooks(): Promise<RpcResponse>;
	getContextFiles(): Promise<RpcResponse>;
	getMcpServers(): Promise<RpcResponse>;
	getGuiThemes(): Promise<RpcResponse>;
	getPlugins(): Promise<RpcResponse>;
	getMarketplaces(): Promise<RpcResponse>;
	getPromptTemplates(): Promise<RpcResponse>;
	getMemoryReport(): Promise<RpcResponse>;
	memorySearch(query: string, limit?: number): Promise<RpcResponse>;
	memorySave(content: string, context?: string): Promise<RpcResponse>;
	memoryQueue(): Promise<RpcResponse>;
	memoryClear(): Promise<RpcResponse>;
	memoryEnqueue(): Promise<RpcResponse>;
	getSecurityDashboard(): Promise<RpcResponse>;
	getSecurityScan(scanId: string): Promise<RpcResponse>;
	securityStart(target: RpcSecurityTargetInput): Promise<RpcResponse>;
	securityCancel(operationId: string): Promise<RpcResponse>;
	securityValidate(scanId: string, findingId: string): Promise<RpcResponse>;
	securitySetDisposition(
		scanId: string,
		findingId: string,
		status: RpcSecurityDispositionStatus,
		rationale?: string,
	): Promise<RpcResponse>;
	getSshHosts(): Promise<RpcResponse>;
	sshManage(payload: {
		action: "create" | "update" | "delete";
		scope: "user" | "project";
		name: string;
		previousName?: string;
		previousScope?: "user" | "project";
		host?: RpcSshHostInput;
	}): Promise<RpcResponse>;
	sshTest(host: RpcSshHostInput & { name: string }): Promise<RpcResponse>;
	getOmpUpdate(): Promise<RpcResponse>;
	getPluginDoctor(): Promise<RpcResponse>;
	getAgentWorktrees(): Promise<RpcResponse>;
	clearAgentWorktrees(): Promise<RpcResponse>;
	getContextReport(): Promise<RpcResponse>;
	getContextInspect(entries?: boolean): Promise<RpcResponse>;
	getContextEntry(entryId: string): Promise<RpcResponse>;
	previewShareSession(): Promise<RpcResponse>;
	shareSession(snapshotId?: string): Promise<RpcResponse>;
	getJobs(): Promise<RpcResponse>;
	getSessionTree(): Promise<RpcResponse>;
	getThemeColors(name: string): Promise<RpcResponse>;
	getTranscript(): Promise<RpcResponse>;
	getTranscriptPage(cursor?: string, limit?: number, fromEnd?: boolean): Promise<RpcResponse>;
	planApproval(
		approved: boolean,
		option?: "execute" | "compact" | "keep_context" | "save",
		feedback?: string,
		savePath?: string,
	): Promise<RpcResponse>;
	getGoal(): Promise<RpcResponse>;
	guidedGoal(initial?: string): Promise<RpcResponse>;
	setAgentsPaused(enabled: boolean): Promise<RpcResponse>;
	getAutopilot(): Promise<RpcResponse>;
	setAutopilot(action: AutopilotAction): Promise<RpcResponse>;
	autopilotBranchStatus(root: string, base: string, branch: string): Promise<RpcResponse>;
	getDelegation(): Promise<RpcResponse>;
	setDelegation(mode: DelegationMode): Promise<RpcResponse>;
	setGoal(args: {
		objective?: string;
		tokenBudget?: number | null;
		timeLimitMinutes?: number | null;
		action?: "pause" | "resume" | "drop";
	}): Promise<RpcResponse>;
	tan(work: string): Promise<RpcResponse>;
	omfg(complaint: string): Promise<RpcResponse>;
	setSkillEnabled(name: string, enabled: boolean): Promise<RpcResponse>;
	manageSkill(args: {
		action: "create" | "update" | "delete";
		name: string;
		description?: string;
		body?: string;
	}): Promise<RpcResponse>;
	setHookEnabled(hookId: string, enabled: boolean): Promise<RpcResponse>;
	setContextFileEnabled(contextFileId: string, enabled: boolean): Promise<RpcResponse>;
	setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<RpcResponse>;
	mcpAction(
		name: string,
		action: "enable" | "disable" | "reconnect" | "remove",
		scope?: "user" | "project",
	): Promise<RpcResponse>;
	setTodos(phases: TodoPhase[]): Promise<RpcResponse>;
	setSubagentSubscription(level: "off" | "progress" | "events"): Promise<RpcResponse>;
	getSubagents(): Promise<RpcResponse>;
	getSubagentMessages(subagentId?: string, sessionFile?: string, fromByte?: number): Promise<RpcResponse>;
	// Voice (speech in/out): audio is canonical PCM16 mono 16 kHz WAV, base64.
	transcribeAudio(audioBase64: string, mimeType: string): Promise<RpcResponse>;
	synthesizeSpeech(text: string): Promise<RpcResponse>;
}

export type RpcTransport = (command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;

/**
 * Commands below resolve only after long-running model, OAuth, transcript, or
 * human-interaction work finishes. The 8s default would report a false
 * timeout while the sidecar keeps mutating state, so these get windows at
 * least as large as their server-side budgets. Fast commands keep the default.
 */
const RPC_COMMAND_TIMEOUTS: Record<string, number> = {
	bash: 660_000,
	eval: 660_000,
	compact: 660_000,
	set_model: 30_000,
	cycle_model: 30_000,
	export_html: 120_000,
	handoff: 660_000,
	reload_plugins: 120_000,
	plan_approval: 660_000,
	switch_leaf: 660_000,
	login: 660_000,
	// Reads every account's quota; each usage request has stock's 10s budget, and
	// a refresh probes one provider's accounts one after another (stock invalidate).
	get_provider_accounts: 60_000,
	get_usage: 60_000,
	// Re-reads the provider's live reset offer for every account of the provider
	// (Claude probes them one by one), then spends one; the spend is never retried.
	redeem_reset_pass: 120_000,
	get_transcript: 30_000,
	get_transcript_page: 30_000,
	// Subagent transcripts also read back every image blob the journal references.
	get_subagent_messages: 30_000,
	get_subagent_transcript: 30_000,
	// Stock answers once the subagent queued the message or started its turn; a parked one is revived first.
	steer_subagent: 30_000,
	// Git/gh commands main runs itself: at least main's own answer budget
	// (src/main/local/git/{worktree,pr}.ts), or the renderer reports a failure
	// while the worktree, checkout, or PR still lands.
	worktree_create: 660_000,
	worktree_remove: 360_000,
	pr_repo: 120_000,
	pr_list: 180_000,
	pr_get: 180_000,
	pr_diff: 180_000,
	pr_draft: 650_000,
	pr_create: 230_000,
	pr_checkout: 770_000,
	pr_merge: 230_000,
	pr_review: 180_000,
	pr_comment: 180_000,
	pr_comments: 240_000,
	pr_edit: 180_000,
	// A clone may take 10 minutes (GITHUB_COMMAND_BUDGET_MS); every other operation answers far sooner.
	github: 730_000,
	// Source control (src/main/local/git/scm.ts SCM_COMMAND_BUDGETS_MS): hooks and network round trips.
	git_stage: 70_000,
	git_unstage: 70_000,
	git_discard: 130_000,
	git_commit: 360_000,
	git_commit_message: 240_000,
	git_last_commit_message: 70_000,
	git_undo_commit: 70_000,
	git_remote: 360_000,
	git_stash: 360_000,
	git_operation: 360_000,
	git_branches: 70_000,
	git_branch: 360_000,
	git_log: 130_000,
	git_commit_detail: 70_000,
	git_commit_diff: 70_000,
	git_history_action: 360_000,
};

export function timeoutForCommand(cmd: RpcCommand): number | undefined {
	return RPC_COMMAND_TIMEOUTS[cmd.type];
}

/** The longest window any command gets; a paired host accepts `tab.command` timeouts up to this. */
export const MAX_RPC_COMMAND_TIMEOUT_MS = Math.max(...Object.values(RPC_COMMAND_TIMEOUTS));

const TRANSCRIPT_PAGE_LIMIT = 256;

function transcriptPageData(response: RpcResponse): MessagesPage | undefined {
	if (!response.success || typeof response.data !== "object" || response.data === null) return undefined;
	const data = response.data as { messages?: unknown; nextCursor?: unknown; totalMessages?: unknown };
	if (
		!Array.isArray(data.messages) ||
		!Number.isSafeInteger(data.totalMessages) ||
		(data.totalMessages as number) < 0 ||
		(data.nextCursor !== undefined && typeof data.nextCursor !== "string")
	)
		return undefined;
	return data as unknown as MessagesPage;
}

async function fetchTranscript(transport: RpcTransport): Promise<RpcResponse> {
	const legacy = () => transport({ type: "get_transcript" });
	let page = await transport({ type: "get_transcript_page", limit: TRANSCRIPT_PAGE_LIMIT });
	if (!page.success) return legacy();

	const messages: MessagesPage["messages"] = [];
	const seenCursors = new Set<string>();
	let totalMessages: number | undefined;
	for (;;) {
		const data = transcriptPageData(page);
		if (!data || (totalMessages !== undefined && totalMessages !== data.totalMessages)) return legacy();
		totalMessages = data.totalMessages;
		messages.push(...data.messages);
		const cursor = data.nextCursor;
		if (!cursor) {
			if (messages.length !== totalMessages) return legacy();
			return { id: page.id, type: "response", command: "get_transcript", success: true, data: { messages } };
		}
		if (seenCursors.has(cursor)) return legacy();
		seenCursors.add(cursor);
		page = await transport({ type: "get_transcript_page", cursor, limit: TRANSCRIPT_PAGE_LIMIT });
		if (!page.success) return legacy();
	}
}

/** One wire adapter shared by preload and task-bound renderer clients; parameter types come from SessionRpcClient. */
export function createSessionRpcClient(transport: RpcTransport): SessionRpcClient {
	const rpcCommand: RpcTransport = (command, timeoutMs) => transport(command, timeoutMs ?? timeoutForCommand(command));
	return {
		command: rpcCommand,
		getState: () => rpcCommand({ type: "get_state" }),
		prompt: (message, images, streamingBehavior) =>
			rpcCommand({ type: "prompt", message, images, streamingBehavior }),
		steer: (message, images) => rpcCommand({ type: "steer", message, images }),
		followUp: (message, images) => rpcCommand({ type: "follow_up", message, images }),
		abort: () => rpcCommand({ type: "abort" }),
		abortAndPrompt: message => rpcCommand({ type: "abort_and_prompt", message }),
		abortAndRestoreQueue: () => rpcCommand({ type: "abort_and_restore_queue" }),
		newSession: parentSession => rpcCommand({ type: "new_session", parentSession }),
		switchSession: (sessionPath, model) => rpcCommand({ type: "switch_session", sessionPath, ...model }),
		branch: entryId => rpcCommand({ type: "branch", entryId }),
		fork: () => rpcCommand({ type: "fork" }),
		eval: (code, language, excluded) => rpcCommand({ type: "eval", code, language, excluded }),
		abortEval: () => rpcCommand({ type: "abort_eval" }),
		abortMaintenance: () => rpcCommand({ type: "abort_maintenance" }),
		dequeue: () => rpcCommand({ type: "dequeue" }),
		getQueue: () => rpcCommand({ type: "get_queue" }),
		queueEdit: (queueId, text) => rpcCommand({ type: "queue_edit", queueId, text }),
		queueRemove: queueId => rpcCommand({ type: "queue_remove", queueId }),
		queueMove: (queueId, toIndex, toLane) => rpcCommand({ type: "queue_move", queueId, toIndex, toLane }),
		queueClear: lane => rpcCommand({ type: "queue_clear", lane }),
		setModel: (provider, modelId) => rpcCommand({ type: "set_model", provider, modelId }),
		cycleModel: direction => rpcCommand({ type: "cycle_model", direction }),
		retry: () => rpcCommand({ type: "retry" }),
		clearContext: () => rpcCommand({ type: "clear_context" }),
		abortSubagent: agentId => rpcCommand({ type: "abort_subagent", agentId }),
		reviveSubagent: agentId => rpcCommand({ type: "revive_subagent", agentId }),
		steerSubagent: (subagentId, message) => rpcCommand({ type: "steer_subagent", subagentId, message }),
		writeLocalPaste: content => rpcCommand({ type: "write_local_paste", content }),
		resolveLocalUrl: url => rpcCommand({ type: "resolve_local_url", url }),
		getActiveTools: () => rpcCommand({ type: "get_active_tools" }),
		setPrewalk: enabled => rpcCommand({ type: "set_prewalk", enabled }),
		fresh: () => rpcCommand({ type: "fresh" }),
		shakeContext: mode => rpcCommand({ type: "shake_context", mode }),
		reloadPlugins: () => rpcCommand({ type: "reload_plugins" }),
		setForceTool: payload => rpcCommand({ type: "set_force_tool", ...payload }),
		getForceTool: () => rpcCommand({ type: "get_force_tool" }),
		listForeignSessions: source => rpcCommand({ type: "list_foreign_sessions", source }, 60_000),
		importForeignSession: (source, foreignId) =>
			rpcCommand({ type: "import_foreign_session", source, foreignId }, 120_000),
		forkFrom: entryId => rpcCommand({ type: "fork_from", entryId }),
		switchLeaf: (entryId, options) => rpcCommand({ type: "switch_leaf", entryId, ...options }),
		getCommandArgCompletions: (command, prefix) =>
			rpcCommand({ type: "get_command_arg_completions", command, prefix }),
		mcpAdd: (name, config, scope) => rpcCommand({ type: "mcp_add", name, config, scope }, 60_000),
		mcpTest: probe => rpcCommand({ type: "mcp_test", ...probe }, 60_000),
		mcpReauth: name => rpcCommand({ type: "mcp_reauth", name }, 360_000),
		mcpReauthCancel: name => rpcCommand({ type: "mcp_reauth_cancel", name }, 10_000),
		marketplaceAction: payload => rpcCommand({ type: "marketplace_action", ...payload }, 180_000),
		getPluginDetail: pluginId => rpcCommand({ type: "get_plugin_detail", pluginId }, 30_000),
		setPluginFeatures: (pluginId, features) => rpcCommand({ type: "set_plugin_features", pluginId, features }),
		setPluginSetting: (pluginId, key, value) => rpcCommand({ type: "set_plugin_setting", pluginId, key, value }),
		deletePluginSetting: (pluginId, key) => rpcCommand({ type: "delete_plugin_setting", pluginId, key }),
		getDirectories: () => rpcCommand({ type: "get_directories" }),
		addDirectory: path => rpcCommand({ type: "add_directory", path }),
		removeDirectory: path => rpcCommand({ type: "remove_directory", path }),
		moveSession: path => rpcCommand({ type: "move_session", path }, 30_000),
		getGitStatus: () => rpcCommand({ type: "get_git_status" }),
		getGitChanges: () => rpcCommand({ type: "get_git_changes" }),
		getGitFingerprint: root => rpcCommand({ type: "get_git_fingerprint", ...(root ? { root } : {}) }),
		getGitDiff: path => rpcCommand({ type: "get_git_diff", path }),
		// Worktree and PR commands run in main; RPC_COMMAND_TIMEOUTS holds their budgets.
		worktreeCreate: (name, options) =>
			rpcCommand({
				type: "worktree_create",
				name,
				baseCwd: options?.baseCwd,
				baseRef: options?.baseRef,
				...(options?.branchPrefix ? { branchPrefix: options.branchPrefix } : {}),
			}),
		worktreeRemove: (path, force) => rpcCommand({ type: "worktree_remove", path, force }),
		prRepo: () => rpcCommand({ type: "pr_repo" }),
		prList: (state, limit, view) => rpcCommand({ type: "pr_list", state, limit, view }),
		prGet: number => rpcCommand({ type: "pr_get", number }),
		prDiff: (number, path) => rpcCommand({ type: "pr_diff", number, path }),
		prDraft: options => rpcCommand({ type: "pr_draft", base: options?.base, head: options?.head }),
		prCreate: input => rpcCommand({ type: "pr_create", ...input }),
		prCheckout: number => rpcCommand({ type: "pr_checkout", number }),
		liveStop: () => rpcCommand({ type: "live_stop" }, 30_000),
		debug: params => rpcCommand({ type: "debug", params }, 120_000),
		getAvailableModels: forceRefresh => rpcCommand({ type: "get_available_models", forceRefresh }),
		setThinkingLevel: level => rpcCommand({ type: "set_thinking_level", level }),
		cycleThinkingLevel: () => rpcCommand({ type: "cycle_thinking_level" }),
		setFastMode: enabled => rpcCommand({ type: "set_fast_mode", enabled }),
		setSlowMode: enabled => rpcCommand({ type: "set_slow_mode", enabled }),
		setSteeringMode: mode => rpcCommand({ type: "set_steering_mode", mode }),
		setFollowUpMode: mode => rpcCommand({ type: "set_follow_up_mode", mode }),
		setInterruptMode: mode => rpcCommand({ type: "set_interrupt_mode", mode }),
		compact: customInstructions => rpcCommand({ type: "compact", customInstructions }),
		setAutoCompaction: enabled => rpcCommand({ type: "set_auto_compaction", enabled }),
		setAutoRetry: enabled => rpcCommand({ type: "set_auto_retry", enabled }),
		abortRetry: () => rpcCommand({ type: "abort_retry" }),
		bash: (command, excluded) => rpcCommand({ type: "bash", command, excluded }),
		abortBash: () => rpcCommand({ type: "abort_bash" }),
		getSessionStats: () => rpcCommand({ type: "get_session_stats" }),
		setSessionPinned: (sessionId, pinned) => rpcCommand({ type: "set_session_pinned", sessionId, pinned }),
		exportHtml: outputPath => rpcCommand({ type: "export_html", outputPath }),
		getBranchMessages: () => rpcCommand({ type: "get_branch_messages" }),
		getCopyTargets: () => rpcCommand({ type: "get_copy_targets" }),
		getLastLink: () => rpcCommand({ type: "get_last_link" }),
		setSessionName: name => rpcCommand({ type: "set_session_name", name }),
		regenerateSessionTitle: () => rpcCommand({ type: "regenerate_session_title" }),
		autoModeDecide: message => rpcCommand({ type: "auto_mode_decide", message }),
		autoModeUndo: mode => rpcCommand({ type: "auto_mode_undo", mode }),
		autoModeEnd: mode => rpcCommand({ type: "auto_mode_end", mode }),
		setEntryLabel: (entryId, label) => rpcCommand({ type: "set_entry_label", entryId, label }),
		handoff: customInstructions => rpcCommand({ type: "handoff", customInstructions }),
		getLoginProviders: () => rpcCommand({ type: "get_login_providers" }),
		login: providerId => rpcCommand({ type: "login", providerId }),
		cancelLogin: url => rpcCommand({ type: "login_cancel", url }),
		logout: (providerId, credentialId) => rpcCommand({ type: "logout", providerId, credentialId }),
		disconnectProvider: providerId => rpcCommand({ type: "logout", providerId, all: true }),
		getProviderAccounts: (providerId, refresh) =>
			rpcCommand({ type: "get_provider_accounts", providerId, ...(refresh ? { refresh: true } : {}) }),
		redeemResetPass: (providerId, credentialId, creditId) =>
			rpcCommand({ type: "redeem_reset_pass", providerId, credentialId, creditId }),
		getUsage: refresh => rpcCommand({ type: "get_usage", ...(refresh ? { refresh: true } : {}) }),
		getSettingsSchema: () => rpcCommand({ type: "get_settings_schema" }),
		getSettings: paths => rpcCommand({ type: "get_settings", paths }),
		setSetting: (path, value) => rpcCommand({ type: "set_setting", path, value }),
		getProviders: forceRefresh => rpcCommand({ type: "get_providers", forceRefresh }),
		setPlanMode: enabled => rpcCommand({ type: "set_plan_mode", enabled }),
		getPlanMode: () => rpcCommand({ type: "get_plan_mode" }),
		getModelRoles: () => rpcCommand({ type: "get_model_roles" }),
		setModelRole: (role, modelId) => rpcCommand({ type: "set_model_role", role, modelId }),
		defineModelRole: (roleId, fields) => rpcCommand({ type: "define_model_role", roleId, ...fields }),
		forgetModelRole: roleId => rpcCommand({ type: "forget_model_role", roleId }),
		getModelRoleMetadata: () => rpcCommand({ type: "get_model_role_metadata" }),
		getCompactionPoints: () => rpcCommand({ type: "get_compaction_points" }),
		getRecentModels: () => rpcCommand({ type: "get_recent_models" }),
		compactionLimits: params => rpcCommand({ type: "compaction_limits", ...params }),
		historyRecent: (limit, cwd) => rpcCommand({ type: "history_recent", limit, cwd }),
		historySearch: (query, limit, cwd) => rpcCommand({ type: "history_search", query, limit, cwd }),
		historyRecord: (prompt, cwd) => rpcCommand({ type: "history_record", prompt, cwd }),
		getAvailableCommands: () => rpcCommand({ type: "get_available_commands" }),
		getSkills: () => rpcCommand({ type: "get_skills" }),
		getSkillDetail: name => rpcCommand({ type: "get_skill_detail", name }),
		getAgentDefinitions: () => rpcCommand({ type: "get_agent_definitions" }),
		getAgentDefinition: name => rpcCommand({ type: "get_agent_definition", name }),
		getAgentAuthoring: () => rpcCommand({ type: "get_agent_authoring" }),
		readAgentFile: filePath => rpcCommand({ type: "read_agent_file", filePath }),
		writeAgentFile: params => rpcCommand({ type: "write_agent_file", ...params }),
		deleteAgentFile: filePath => rpcCommand({ type: "delete_agent_file", filePath }),
		installAgentTemplates: (scope, names) => rpcCommand({ type: "install_agent_templates", scope, names }),
		getHooks: () => rpcCommand({ type: "get_hooks" }),
		getContextFiles: () => rpcCommand({ type: "get_context_files" }),
		getMcpServers: () => rpcCommand({ type: "get_mcp_servers" }),
		getGuiThemes: () => rpcCommand({ type: "get_gui_themes" }),
		getPlugins: () => rpcCommand({ type: "get_plugins" }),
		getMarketplaces: () => rpcCommand({ type: "get_marketplaces" }),
		getPromptTemplates: () => rpcCommand({ type: "get_prompt_templates" }),
		getMemoryReport: () => rpcCommand({ type: "get_memory_report" }),
		memorySearch: (query, limit) => rpcCommand({ type: "memory_search", query, limit }, 60_000),
		memorySave: (content, context) => rpcCommand({ type: "memory_save", content, context }, 60_000),
		memoryQueue: () => rpcCommand({ type: "memory_queue" }),
		memoryClear: () => rpcCommand({ type: "memory_clear" }, 60_000),
		// Consolidation may run a model turn on the local backend.
		memoryEnqueue: () => rpcCommand({ type: "memory_enqueue" }, 300_000),
		getSecurityDashboard: () => rpcCommand({ type: "get_security_dashboard" }, 60_000),
		getSecurityScan: scanId => rpcCommand({ type: "get_security_scan", scanId }, 30_000),
		securityStart: target => rpcCommand({ type: "security_start", target }, 120_000),
		securityCancel: operationId => rpcCommand({ type: "security_cancel", operationId }),
		securityValidate: (scanId, findingId) => rpcCommand({ type: "security_validate", scanId, findingId }, 30_000),
		securitySetDisposition: (scanId, findingId, status, rationale) =>
			rpcCommand({ type: "security_set_disposition", scanId, findingId, status, rationale }),
		getSshHosts: () => rpcCommand({ type: "get_ssh_hosts" }, 30_000),
		sshManage: payload => rpcCommand({ type: "ssh_manage", ...payload }, 30_000),
		sshTest: host => rpcCommand({ type: "ssh_test", host }, 60_000),
		getOmpUpdate: () => rpcCommand({ type: "get_omp_update" }, 60_000),
		getPluginDoctor: () => rpcCommand({ type: "get_plugin_doctor" }, 90_000),
		getAgentWorktrees: () => rpcCommand({ type: "get_agent_worktrees" }, 60_000),
		// Removing a task-isolation mount or a large checkout can take a while.
		clearAgentWorktrees: () => rpcCommand({ type: "clear_agent_worktrees" }, 5 * 60_000),
		getContextReport: () => rpcCommand({ type: "get_context_report" }),
		getContextInspect: entries => rpcCommand({ type: "get_context_inspect", entries }),
		getContextEntry: entryId => rpcCommand({ type: "get_context_entry", entryId }),
		// Uploads + seals the session snapshot to the share server — network-bound.
		previewShareSession: () => rpcCommand({ type: "preview_share_session" }),
		shareSession: snapshotId => rpcCommand({ type: "share_session", snapshotId }, 120_000),
		getJobs: () => rpcCommand({ type: "get_jobs" }),
		getSessionTree: () => rpcCommand({ type: "get_session_tree" }),
		getThemeColors: name => rpcCommand({ type: "get_theme_colors", name }),
		getTranscript: () => fetchTranscript(rpcCommand),
		getTranscriptPage: (cursor, limit, fromEnd) =>
			rpcCommand({ type: "get_transcript_page", cursor, limit, fromEnd }),
		planApproval: (approved, option, feedback, savePath) =>
			rpcCommand({ type: "plan_approval", approved, option, feedback, savePath }),
		getAutopilot: () => rpcCommand({ type: "get_autopilot" }),
		setAutopilot: action => rpcCommand({ type: "set_autopilot", ...action }),
		autopilotBranchStatus: (root, base, branch) =>
			rpcCommand({ type: "autopilot_branch_status", root, base, branch }),
		getDelegation: () => rpcCommand({ type: "get_delegation" }),
		setDelegation: mode => rpcCommand({ type: "set_delegation", mode }),
		getGoal: () => rpcCommand({ type: "get_goal" }),
		guidedGoal: initial => rpcCommand({ type: "guided_goal", initial }),
		setAgentsPaused: enabled => rpcCommand({ type: "set_agents_paused", enabled }),
		setGoal: args => rpcCommand({ type: "set_goal", ...args }),
		tan: work => rpcCommand({ type: "tan", work }),
		omfg: complaint => rpcCommand({ type: "omfg", complaint }),
		setSkillEnabled: (name, enabled) => rpcCommand({ type: "set_skill_enabled", name, enabled }),
		manageSkill: args => rpcCommand({ type: "manage_skill", ...args }),
		setHookEnabled: (hookId, enabled) => rpcCommand({ type: "set_hook_enabled", hookId, enabled }),
		setContextFileEnabled: (contextFileId, enabled) =>
			rpcCommand({ type: "set_context_file_enabled", contextFileId, enabled }),
		setPluginEnabled: (pluginId, enabled, scope) =>
			rpcCommand({ type: "set_plugin_enabled", pluginId, enabled, scope }),
		mcpAction: (name, action, scope) => rpcCommand({ type: "mcp_action", name, action, scope }),
		setTodos: phases => rpcCommand({ type: "set_todos", phases }),
		setSubagentSubscription: level => rpcCommand({ type: "set_subagent_subscription", level }),
		getSubagents: () => rpcCommand({ type: "get_subagents" }),
		getSubagentMessages: (subagentId, sessionFile, fromByte) =>
			rpcCommand({ type: "get_subagent_messages", subagentId, sessionFile, fromByte }),
		// Voice — AgentVoice region; keep at the end of the rpc object. Generous timeouts: the first call
		// on a fresh sidecar loads the STT/TTS model into the worker, far beyond the default 8s RPC timeout.
		transcribeAudio: (audioBase64, mimeType) =>
			rpcCommand({ type: "transcribe_audio", audioBase64, mimeType }, 120_000),
		synthesizeSpeech: text => rpcCommand({ type: "synthesize_speech", text }, 60_000),
	};
}
