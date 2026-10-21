/**
 * Compatibility self-check: every omp internal the bridge modules use, grouped
 * by the GUI feature that needs it. omp internals carry no semver, so after an
 * `omp update` a method can vanish; `capabilities` (index.ts) reports which
 * features lost something, and `guard` (health.ts) fails their bridge methods
 * with a coded `unsupported_omp` error instead of a raw TypeError.
 *
 * Pure on purpose: no omp imports (not even types) and no Bun globals, so the
 * GUI's own vitest/tsc can exercise the derivation with fake objects
 * (src/main/bridge-capabilities.test.ts). Keep the table in sync when a bridge
 * module starts using another internal.
 *
 * Requirement paths are dotted member paths. A trailing `()` requires a
 * function; anything else only has to exist (`in`, so optional getters count).
 */

export const FEATURES = {
	core: "GUI bridge core",
	composer: "Composer extras (eval, forced tool, prewalk, context, jobs, dequeue)",
	share: "Session sharing",
	planMode: "Plan mode",
	goalMode: "Goal mode",
	tan: "/tan background tangents",
	omfg: "/omfg rule forging",
	agentPause: "Agent pause",
	replyLanguage: "Reply language",
	nextPrompt: "Prompt suggestions (next message, inline completion)",
	autoTitle: "Automatic session titles (first message, as the work changes, regenerate)",
	autoMode: "Automatic mode choice (Plan or Goal for a prompt)",
	judgeAssist: "Judge-model assists (needs-you notifications, title check, preview check)",
	memoryRecall: "Memory recall (earlier decisions and conclusions for a typed prompt)",
	outputStyle: "Output style (concise, detailed, minimal)",
	userProfile: "User profile (name, experience)",
	visuals: "Diagram instructions (Mermaid, SVG)",
	accountRotation: "Account rotation (even, quota re-rank at turn start)",
	thinkingDefault: "Auto thinking by default",
	delegation: "Delegation strength (Solo to Swarm)",
	mcp: "MCP servers",
	plugins: "Plugins & marketplaces",
	skills: "Skills, hooks & prompt templates",
	agents: "Agent definitions & memory",
	themes: "Themes",
	settings: "Settings",
	models: "Model catalog",
	providers: "Providers & logout",
	modelRoles: "Model roles",
	modelSetupFacts: "Model setup (billing and model facts)",
	usage: "Usage",
	security: "Security scans",
	ssh: "SSH hosts",
	voice: "Voice input & speech",
	debug: "Debug console",
	sessionTree: "Session tree, labels & pins",
	sessionImport: "Claude/Codex session import",
	workspace: "Workspace directories",
	compactionLimits: "Per-model compaction limits",
	idleCompaction: "Idle compaction (compaction.idleEnabled)",
	sessionRecap: "Idle recap (recap.enabled)",
	contextInspector: "Context inspector (per-entry tokens)",
	promptOrigin: "Prompt origins (from another device)",
	recentModels: "Recent models in the model picker",
	inputHistory: "Shared prompt history",
	accountPools: "Agent account pools",
	worktreeLifecycle: "Per-session worktrees (worktree.onStart / onExit)",
	resetPasses: "Saved rate-limit resets (reset passes)",
	streamMetadata: "Stock read grouping and live token rate",
	agentBrowser: "Agent browsing in the Preview panel (stock browser relay)",
	agentControl: "OMPdesk control tools (confirmation cards)",
	autopilot: "Autopilot (guarded, unattended Goal loop)",
	desktopSlot: "Desktop slot (one session drives the screen at a time)",
	phoneImages: "HEIC photos from a phone converted for the model",
	pstack: "pstack engineering mode (always-on playbook section)",
	eccHint: "ECC skills named for the project's languages (prompt section)",
	backgroundChecks: "Long checks run as background jobs (prompt section)",
	checkoutPeers: "Sessions sharing a checkout (prompt section and git guard)",
	sessionDump: "Session dump archive saved as a file (/dump all, /dump anon)",
	advisorStats: "Advisor spend and advisories (Run popover, Insights)",
	todoReminder: "A refused todo call's reminder reaches its own turn, and the turn then reads finished",
	todoStale: "A todo list left from earlier work is named to the agent when a new request starts a turn",
} as const;

export type FeatureId = keyof typeof FEATURES;

export interface FeatureRequirement {
	/** Members of the live AgentSession. */
	session?: readonly string[];
	/** Members of omp's package index (`env.pi.pi`). */
	pkg?: readonly string[];
	/** Module specifier → export paths. */
	modules?: Readonly<Record<string, readonly string[]>>;
	/** omp prompt templates under `src/prompts` (see modes/shared.ts `ompPrompt`). */
	prompts?: readonly string[];
}

export interface UnavailableFeature {
	feature: FeatureId;
	missing: string[];
}

const AGENT = "@oh-my-pi/pi-coding-agent";
const UTILS = "@oh-my-pi/pi-utils";

export const REQUIREMENTS: Readonly<Record<FeatureId, FeatureRequirement>> = {
	core: {
		pkg: ["VERSION", "AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
	},
	streamMetadata: {
		session: ["subscribe()", "tokenRate.rate()"],
		modules: {
			"@oh-my-pi/pi-coding-agent/internal-urls/router": [
				"InternalUrlRouter.instance()",
				"InternalUrlRouter.prototype.spec()",
			],
			"@oh-my-pi/pi-tui/tools/url-scheme-host": ["splitUrlScheme()"],
			"@oh-my-pi/pi-tui/tools/read": ["splitPathAndSel()"],
		},
	},
	/**
	 * browser-relay.ts: stock's `omp browser-relay` server inside the session, with
	 * `browser.relay`/`browser.relayUrl` held as runtime overrides (handles via `lookup`).
	 */
	agentBrowser: {
		session: ["settings"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/tools/browser/attach`]: ["findFreeCdpPort()"],
			[`${AGENT}/tools/browser/relay/server`]: ["startRelayServer()"],
			[`${AGENT}/tools/browser/settings`]: [
				"cfgBrowserRelay.override()",
				"cfgBrowserRelay.clearOverride()",
				"cfgBrowserRelayUrl.override()",
				"cfgBrowserRelayUrl.clearOverride()",
			],
		},
	},
	composer: {
		session: [
			"getActiveToolNames()",
			"toolChoiceQueue.pushSequence()",
			"toolChoiceQueue.removeByLabel()",
			"toolChoiceQueue.inspect()",
			"getPrewalkState()",
			"disarmPrewalk()",
			"autoRetryEnabled",
			"configuredThinkingLevel()",
			"executePython()",
			"abortEval()",
			"abortCompaction()",
			"abortHandoff()",
			"isCompacting",
			"isGeneratingHandoff",
			"executeBash()",
			"resetSessionContext()",
			"getContextBreakdown()",
			"getAsyncJobTree()",
			"inspectAsyncJob()",
			"cancelAsyncJob()",
			"cycleModel()",
			"isFastModeEnabled()",
			"isFastModeActive()",
			"isUltrafastModeEnabled()",
			"setUltrafastMode()",
			"popLastQueuedMessage()",
			"getQueuedMessages()",
			"agent.state",
			"hasBuiltInTool()",
			"getXdevToolEntries()",
			"settings",
			"model",
			"skills",
			"sessionManager.getCwd()",
			"sessionManager.getArtifactsDir()",
			"sessionManager.getSessionId()",
			"restoreInterruptedTurn()",
			"getToolByName()",
			"sessionManager.getBranch()",
			"promptCustomMessage()",
			"sessionManager.appendMessage()",
			"isStreaming",
			"getGoalModeState()",
		],
		modules: {
			"@oh-my-pi/pi-agent-core": ["agentPauseGate.paused", "agentPauseGate.pausedAt"],
			"@oh-my-pi/pi-ai": ["serviceTierFamily()", "shouldSendServiceTier()"],
			"@oh-my-pi/pi-tui/overlays/job-tree": ["buildJobTree()"],
			"@oh-my-pi/pi-tui/overlays/copy-targets": [
				"extractBlocks()",
				"commandFromToolCall()",
				"assistantText()",
				"extractLastLink()",
			],
			[`${AGENT}/utils/tool-choice`]: ["buildNamedToolChoice()"],
			[`${AGENT}/task/restore`]: ["restoreSession()"],
			[`${AGENT}/session/exit-diagnostics`]: ["createInterruptedTurnAbortMessage()"],
			[`${AGENT}/internal-urls/local-protocol`]: ["resolveLocalRoot()", "resolveLocalUrlToPath()"],
			[`${AGENT}/slash-commands/builtin-completions`]: ["buildMcpArgumentCompletions()"],
			[`${AGENT}/slash-commands/builtin-registry`]: ["BUILTIN_SLASH_COMMANDS"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
			[UTILS]: ["isEexist()", "getProjectDir()"],
		},
	},
	share: {
		session: ["state", "obfuscator", "settings", "sessionManager"],
		modules: {
			[`${AGENT}/export/share`]: [
				"buildShareSnapshot()",
				"normalizeShareServerUrl()",
				"shareSession()",
				"sealToFit()",
				"SERVER_MAX_SEALED_BYTES",
			],
			[`${AGENT}/commands/settings`]: [
				"cfgShareServerUrl.get()",
				"cfgShareStore.get()",
				"cfgShareRedactSecrets.get()",
			],
		},
	},
	planMode: {
		session: [
			"subscribe()",
			"getPlanModeState()",
			"setPlanModeState()",
			"peekPlanProposalHandler()",
			"setPlanProposalHandler()",
			"preparePlanForReview()",
			"getGoalModeState()",
			"getEnabledToolNames()",
			"getPlanReferencePath()",
			"setPlanReferencePath()",
			"markPlanReferenceSent()",
			"hasBuiltInTool()",
			"setActiveToolsByName()",
			"sendPlanModeContext()",
			"markPlanInternalAbortPending()",
			"clearPlanInternalAbortPending()",
			"abort()",
			"newSession()",
			"compact()",
			"prompt()",
			"followUp()",
			"setSessionName()",
			"isStreaming",
			"sessionManager.appendModeChange()",
			"sessionManager.getArtifactsDir()",
			"sessionManager.getSessionId()",
			"sessionManager.getSessionName()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/plan-mode/plan-files`]: ["readPlanFile()"],
			[`${AGENT}/plan-mode/approved-plan`]: ["humanizePlanTitle()"],
			[`${AGENT}/tools/resolve`]: ["writeDeviceDispatch()"],
			"@oh-my-pi/pi-tui/tools/resolve": ["PROPOSE_DEVICE_NAME"],
			[`${AGENT}/internal-urls`]: ["copyLocalArtifacts()", "resolveLocalUrlToPath()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/plan-mode-compact-instructions.md", "system/plan-mode-approved.md"],
	},
	goalMode: {
		session: [
			"subscribe()",
			"getGoalModeState()",
			"setGoalModeState()",
			"getPlanModeState()",
			"getEnabledToolNames()",
			"setActiveToolsByName()",
			"sendGoalModeContext()",
			"prompt()",
			"followUp()",
			"isStreaming",
			"goalRuntime.replaceGoal()",
			"goalRuntime.onBudgetMutated()",
			// Time limit (goal-time-core.ts): the journal entry; main pauses through stock RPC `goal pause`.
			"sessionManager.getBranch()",
			"sessionManager.appendCustomEntry()",
		],
		modules: {
			// `goal.enabled` through stock's registry: omp's bundle does not export `goals/settings` (see COPY_SAFE).
			[`${AGENT}/config/registry`]: ["lookup()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["goals/guided-goal-interview.md"],
	},
	tan: {
		session: ["subscribe()", "sessionManager", "settings"],
		modules: {
			[`${AGENT}/modes/controllers/tan-command-controller`]: ["TanCommandController.prototype.start()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
		},
	},
	omfg: {
		session: [
			"subscribe()",
			"runEphemeralTurn()",
			"ruleJudge()",
			"messages",
			"agent.state",
			"ttsrManager.addRule()",
			"model",
			"settings.getAgentDir()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/modes/controllers/omfg-rule`]: [
				"parseGeneratedRule()",
				"extractGeneratedRuleJson()",
				"validateParsedRuleAgainstAssistantHistory()",
				"historyOutputs()",
				"buildOmfgRuleForPath()",
			],
			[`${AGENT}/session/ttsr-outputs`]: ["TtsrToolInspector()"],
			[`${AGENT}/capability`]: ["invalidate()"],
			[UTILS]: ["prompt.render()", "CONFIG_DIR_NAME"],
		},
		prompts: ["system/omfg-user.md"],
	},
	agentPause: {
		modules: {
			"@oh-my-pi/pi-agent-core": ["agentPauseGate.pause()", "agentPauseGate.resume()", "agentPauseGate.pausedAt"],
		},
	},
	/** Only the public `before_agent_start` hook; no internals to probe. */
	replyLanguage: {},
	/**
	 * agent-control.ts: the public extension context's `ui.confirm`, and `agent_control.judge` (`ompdesk_compare` with
	 * criteria): one request on stock's `advisor` role, then `slow`, through next-prompt-engine's `completeOnSmol`
	 * (`roleCandidatePool`, `resolveRoleChain`, the session's credentials, `completeSimple`). It prefers a candidate
	 * whose `Model.identity.class` (the vendor lineage) differs from the session's own model (`AgentSession.model`).
	 * Stored transcripts are read in the stock helper (`loadSessionMessagesReadOnly`, `stock-helper/sessions.ts`). A
	 * no-turn report holds while `isStreaming` and goes to the same `sessionId` once the turn ended.
	 */
	agentControl: {
		session: [
			"settings",
			"sessionId",
			"isStreaming",
			"model",
			"modelRegistry.getApiKey()",
			"modelRegistry.resolver()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["completeSimple()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/session/session-loader`]: ["loadSessionMessagesReadOnly()"],
		},
	},
	/**
	 * modes/autopilot.ts: the tool set (`ask`/`eval`/`debug` off, the `autopilot` tool on), the session-only
	 * `tools.approvalMode` override, the cycle ledger in the journal, usage from the session stats, the todo
	 * list for stall classification, and the extension API's zod for the tool schema.
	 */
	autopilot: {
		pkg: ["AgentRegistry.global()", "MAIN_AGENT_ID", "z.object()", "z.enum()", "z.array()", "z.literal()"],
		session: [
			"subscribe()",
			"settings",
			"isStreaming",
			"getEnabledToolNames()",
			"getAllToolNames()",
			"setActiveToolsByName()",
			"getMountedXdevToolNames()",
			"setActiveToolPresentation()",
			"getGoalModeState()",
			"getPlanModeState()",
			"getTodoPhases()",
			"getSessionStats()",
			"sessionManager.getBranch()",
			"sessionManager.appendCustomEntry()",
		],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	/** modes/output-style.ts: the same public hook as the reply language. */
	outputStyle: {},
	/** modes/checkout-peers.ts: public hooks only (`before_agent_start`, `tool_call`). */
	checkoutPeers: {},
	/** modes/pstack.ts: the always-on pstack section reads the main session's plan mode and tool set. */
	pstack: {
		pkg: ["AgentRegistry.global()", "MAIN_AGENT_ID"],
		session: ["getPlanModeState()", "getActiveToolNames()", "sessionManager.getBranch()"],
	},
	/** modes/ecc-hint.ts: the public `before_agent_start` hook and the context's `cwd` only. */
	eccHint: {},
	/** modes/background-checks.ts: reads stock `async.enabled` by id. */
	backgroundChecks: {
		pkg: ["Settings.instance"],
		session: ["sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	/** modes/user-profile.ts: the same public hook as the reply language. */
	userProfile: {},
	/** modes/visuals.ts: stock's Visuals prompt section, rendered with the tui.renderMermaid / tui.renderSvg settings. */
	visuals: {
		pkg: ["Settings.instance"],
		modules: {
			[`${AGENT}/modes/settings`]: ["cfgTuiRenderMermaid.get()", "cfgTuiRenderSvg.get()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/system-prompt.md"],
	},
	/**
	 * account-rotation.ts: even rotation and quota re-ranking pin a session's account through public AuthStorage
	 * namespaces. Quota re-ranking asks stock's selector (`keys.getWithCredential`, `recordAffinity: false`) for its
	 * pick, reads a pin's explicitness through `sessions.inherit`'s `include` callback, skips pooled sessions
	 * (`sessions.permits`) and accounts with a policy (`oauth.policy`), and orders two accounts' own reports
	 * (`credentials.list`, `usage.report`) with stock's comparator (`orderUsageRankedCandidates`).
	 */
	accountRotation: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()"],
		session: [
			"sessionId",
			"modelRegistry.authStorage.oauth.accounts()",
			"modelRegistry.authStorage.oauth.policy()",
			"modelRegistry.authStorage.sessions.pin()",
			"modelRegistry.authStorage.sessions.inherit()",
			"modelRegistry.authStorage.sessions.permits()",
			"modelRegistry.authStorage.sessions.release()",
			"modelRegistry.authStorage.blocks.list()",
			"modelRegistry.authStorage.keys.getWithCredential()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.usage.report()",
		],
		modules: {
			"@oh-my-pi/pi-ai/auth/blocks": [
				"ACCOUNT_POLICY_BLOCK_SCOPE",
				"AUTH_BLOCK_SCOPE",
				"credentialBlockScopesForRequest()",
				"providerTypeKey()",
			],
			"@oh-my-pi/pi-ai/auth/rank": ["orderUsageRankedCandidates()", "planPriority()"],
			"@oh-my-pi/pi-ai/auth/usage-report": [
				"normalizeUsageFraction()",
				"remainingUsageFraction()",
				"windowRequiredDrain()",
			],
			"@oh-my-pi/pi-ai/usage/registry": ["defaultRankingStrategy()"],
			[`${AGENT}/session/credential-pin`]: ["credentialPinHash()"],
		},
	},
	/** session-dump.ts: the two session methods `/dump all` and `/dump anon` run, called directly for their zip. */
	sessionDump: {
		session: ["dumpSessionArchiveToTmpDir()", "dumpAnonymizedArchiveToTmpDir()"],
	},
	/** advisor-stats.ts: stock's advisor stats and branch. It imports nothing from omp, so health.ts has no LOADERS entry for it. */
	advisorStats: {
		session: ["getAdvisorStats()", "isAdvisorUsingSubscription()", "sessionManager.getBranch()"],
	},
	/** todo-reminder.ts: wraps the session's `sendCustomMessage` for stock's `todo-error-reminder`. Imports nothing from omp. */
	todoReminder: {
		session: ["sendCustomMessage()", "isStreaming"],
	},
	/** todo-stale.ts: stock's journal todo readers, the session's active tools and plan state, at each turn's start. */
	todoStale: {
		session: ["getActiveToolNames()", "getPlanModeState()", "sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/tools/todo`]: ["getLatestTodoPhasesFromEntries()", "getLatestTodoSnapshotIdentity()"],
		},
	},
	/**
	 * desktop-slot.ts: patches stock's `ComputerSupervisor.prototype.run` (a read-only run passes, an acting run waits
	 * for the slot) and awaits `revokeControl()` on every supervisor it saw before the slot is handed on. Without
	 * either the bridge keeps stock behaviour.
	 */
	desktopSlot: {
		modules: {
			[`${AGENT}/tools/computer/supervisor`]: [
				"ComputerSupervisor.prototype.run()",
				"ComputerSupervisor.prototype.revokeControl()",
			],
		},
	},
	/** modes/delegation.ts: runtime overrides of stock's task settings; each handle is reached through `lookup`. */
	delegation: {
		pkg: ["Settings.instance"],
		session: ["settings"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/task/settings`]: [
				"cfgTaskEager.override()",
				"cfgTaskEager.clearOverride()",
				"cfgTaskMaxConcurrency.override()",
				"cfgTaskMaxConcurrency.clearOverride()",
				"cfgTaskMaxRecursionDepth.override()",
				"cfgTaskMaxRecursionDepth.clearOverride()",
			],
		},
	},
	/**
	 * thinking-default.ts: OMPdesk's runtime-override defaults (`auto` for `defaultThinkingLevel`,
	 * "rpc" in `goal.continuationModes`, token usage, LSP diagnostics/format, ast_grep, the advisor;
	 * index.ts applies them before the first session, settings.ts re-checks them). Every handle is
	 * reached through `lookup` and a missing one is skipped (warned), so only the thinking level and its
	 * ceiling are probed here: the `session/settings` entries (`goal.continuationModes` is `lookup` only).
	 */
	thinkingDefault: {
		pkg: ["Settings.instance.getGlobalSettings()", "Settings.instance.getProjectSettings()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/session/settings`]: [
				"cfgDefaultThinkingLevel.id",
				"cfgDefaultThinkingLevel.segments",
				"cfgDefaultThinkingLevel.isConfigured()",
				"cfgDefaultThinkingLevel.override()",
				"cfgDefaultThinkingLevel.clearOverride()",
				"cfgProvidersAutoThinkingMaxEffort.id",
				"cfgProvidersAutoThinkingMaxEffort.segments",
				"cfgProvidersAutoThinkingMaxEffort.isConfigured()",
				"cfgProvidersAutoThinkingMaxEffort.override()",
				"cfgProvidersAutoThinkingMaxEffort.clearOverride()",
			],
		},
	},
	mcp: {
		session: [
			"setMCPPromptCommands()",
			"getEvalPreludes()",
			"refreshMCPTools()",
			"effectiveExtensionRoots",
			"settings",
			"settings.getAgentDir()",
			"sessionManager.getCwd()",
			"modelRegistry.authStorage.credentials.set()",
			"modelRegistry.authStorage.credentials.reload()",
		],
		modules: {
			[`${AGENT}/capability`]: [
				"loadCapability()",
				"isForeignUserProvider()",
				"isProviderEnabled()",
				"isUserSourceEnabled()",
			],
			[`${AGENT}/capability/fs`]: ["clearCache()"],
			[`${AGENT}/discovery/helpers`]: ["expandEnvVarsDeep()"],
			[`${AGENT}/mcp/client`]: ["connectToServer()", "disconnectServer()", "listTools()"],
			[`${AGENT}/mcp/config`]: ["loadAllMCPConfigs()", "validateServerConfig()"],
			[`${AGENT}/modes/controllers/mcp-command-controller`]: ["MCPCommandController.prototype.reloadServers()"],
			[`${AGENT}/modes/components/extensions/mcp-runtime`]: ["applyMcpToggleRuntime()"],
			"@oh-my-pi/pi-tui/overlays/extensions/mcp-runtime": ["inferMcpTransport()"],
			[`${AGENT}/mcp/config-writer`]: [
				"addMCPServer()",
				"readMCPConfigFile()",
				"removeMCPServer()",
				"setMcpServerEnabled()",
				"updateMCPServer()",
			],
			[`${AGENT}/mcp/manager`]: [
				"MCPManager.instance()",
				"MCPManager.prototype.disconnectAll()",
				"MCPManager.prototype.discoverAndConnect()",
				"MCPManager.prototype.connectServers()",
				"MCPManager.prototype.reconnectServer()",
				"MCPManager.prototype.getTools()",
				"MCPManager.prototype.getServerConfig()",
				"MCPManager.prototype.getSource()",
				"MCPManager.prototype.getConnectionStatus()",
				"MCPManager.prototype.setAuthStorage()",
				"MCPManager.prototype.prepareConfig()",
				"MCPManager.prototype.getAllServerNames()",
				"MCPManager.prototype.disconnectServer()",
				"MCPManager.prototype.addConnectionStatusListener()",
			],
			[`${AGENT}/mcp/oauth-credentials`]: [
				"hasMcpAuthorizationHeader()",
				"lookupMcpOAuthCredential()",
				"lookupMcpOAuthCredentialForServer()",
				"removeManagedMcpOAuthCredential()",
			],
			[`${AGENT}/mcp/oauth-discovery`]: [
				"analyzeAuthError()",
				"discoverOAuthEndpoints()",
				"fetchResourceMetadataScopes()",
			],
			[`${AGENT}/mcp/oauth-flow`]: [
				"MCPOAuthFlow()",
				"MCPOAuthFlow.prototype.login()",
				"MCPOAuthFlow.prototype.resolvedClientId",
				"MCPOAuthFlow.prototype.registeredClientSecret",
				"MCPOAuthFlow.prototype.resource",
				"MCPOAuthFlow.prototype.authorizationUrl",
				"mcpOAuthCredentialId()",
			],
			[`${AGENT}/mcp/settings`]: ["cfgMcpEnableProjectConfig.get()"],
			[UTILS]: ["getMCPConfigPath()", "Snowflake.next()"],
		},
	},
	plugins: {
		session: ["refreshSkillsAndCommands()", "settings.flush()", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/discovery/helpers`]: [
				"clearPluginRootsAndCaches()",
				"resolveActiveProjectRegistryPath()",
				"resolveOrDefaultProjectRegistryPath()",
			],
			[`${AGENT}/extensibility/plugins/loader`]: ["getEnabledPlugins()", "resolvePluginManifestEntries()"],
			[`${AGENT}/extensibility/plugins/manager`]: [
				"validateSetting()",
				"PluginManager.prototype.list()",
				"PluginManager.prototype.getPlugin()",
				"PluginManager.prototype.setEnabled()",
				"PluginManager.prototype.getPluginSettings()",
				"PluginManager.prototype.setEnabledFeatures()",
				"PluginManager.prototype.setPluginSetting()",
				"PluginManager.prototype.deletePluginSetting()",
				"PluginManager.prototype.upgrade()",
			],
			[`${AGENT}/extensibility/plugins/git-url`]: ["parseGitUrl()"],
			[`${AGENT}/cli/npm-registry`]: ["loadNpmRegistryResolver()", "npmRegistryPackageUrl()"],
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"classifySource()",
				"parsePluginId()",
				"getInstalledPluginsRegistryPath()",
				"getMarketplacesCacheDir()",
				"getMarketplacesRegistryPath()",
				"getPluginsCacheDir()",
				"MarketplaceManager.prototype.listMarketplaces()",
				"MarketplaceManager.prototype.listAvailablePlugins()",
				"MarketplaceManager.prototype.listInstalledPlugins()",
				"MarketplaceManager.prototype.addMarketplace()",
				"MarketplaceManager.prototype.removeMarketplace()",
				"MarketplaceManager.prototype.updateMarketplace()",
				"MarketplaceManager.prototype.updateAllMarketplaces()",
				"MarketplaceManager.prototype.installPlugin()",
				"MarketplaceManager.prototype.uninstallPlugin()",
				"MarketplaceManager.prototype.upgradePlugin()",
				"MarketplaceManager.prototype.setPluginEnabled()",
				// The Updates section's extension updater (stock-helper/extensions.ts) checks and upgrades through these.
				"MarketplaceManager.prototype.checkForUpdates()",
			],
			[UTILS]: ["pathIsWithin()", "getPluginsPackageJson()"],
		},
	},
	skills: {
		session: [
			"skills",
			"promptTemplates",
			"effectiveExtensionRoots",
			"refreshSkills()",
			"refreshBaseSystemPrompt()",
			"settings.flush()",
			"settings.getAgentDir()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/capability`]: ["loadCapability()", "reset()"],
			[`${AGENT}/capability/context-file`]: ["contextFileCapability.id", "contextFileCapability.toExtensionId()"],
			[`${AGENT}/capability/hook`]: ["hookCapability.id"],
			[`${AGENT}/autolearn/managed-skills`]: ["MANAGED_SKILLS_PROVIDER_ID", "sanitizeSkillName()"],
			// Writes go through stock's tool: the session's own per-skill mutation chain (see COPY_SAFE).
			[`${AGENT}/tools/manage-skill`]: ["ManageSkillTool.prototype.execute()"],
			[`${AGENT}/config/prompt-templates`]: ["templateUsesInlineArgPlaceholders()"],
			[`${AGENT}/config/registry`]: [
				"lookup()",
				"Setting.prototype.get()",
				"Setting.prototype.setMember()",
				"Setting.prototype.provenance()",
			],
			[UTILS]: ["parseFrontmatter()"],
			// The Updates section's extension updater reads these in the stock helper's `extensions` worker
			// (stock-helper/extensions.ts): registry-skill installs, skill discovery for the plugin/local counts.
			[`${AGENT}/config/settings`]: ["Settings.loadReadOnly()", "Settings.prototype.extensionsSourceLevel()"],
			[`${AGENT}/discovery`]: ["initializeWithSettings()", "loadCapability()"],
			[`${AGENT}/extensibility/settings`]: ["cfgSkills.get()", "cfgDisabledExtensions.get()", "cfgExtensions.get()"],
			[`${AGENT}/extensibility/skills`]: ["loadSkills()"],
			[`${AGENT}/skillshare/client`]: [
				"SkillshareClient.create()",
				"SkillshareClient.prototype.packument()",
				"SkillshareClient.prototype.close()",
			],
			[`${AGENT}/skillshare/installer`]: ["listInstalledSkills()", "resolveSkillVersion()", "updateSkillPackages()"],
			[`${AGENT}/skillshare/manifest`]: ["getProjectSkillsInstallPaths()"],
		},
	},
	agents: {
		session: [
			"effectiveExtensionRoots",
			"model",
			"modelRegistry",
			"settings.getModelRole()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/config`]: ["getConfigDirs()", "findAllNearestProjectConfigDirs()"],
			[`${AGENT}/config/model-resolver`]: ["formatModelString()"],
			[`${AGENT}/discovery/helpers`]: ["parseAgentFields()"],
			[`${AGENT}/modes/agents-hub-deps`]: ["createAgentsHubDeps()"],
			[`${AGENT}/modes/rpc/rpc-subagents`]: ["readRpcSubagentTranscript()"],
			[`${AGENT}/session/blob-store`]: ["BlobStore()", "BlobStore.prototype.get()", "parseBlobRef()"],
			[`${AGENT}/task/agents`]: ["AgentParsingError"],
			[UTILS]: ["parseFrontmatter()", "getBlobsDir()"],
			[`${AGENT}/registry/agent-lifecycle`]: [
				"AgentLifecycleManager.global()",
				"AgentLifecycleManager.prototype.ensureLive()",
			],
			[`${AGENT}/registry/agent-registry`]: [
				"AgentRegistry.global()",
				"AgentRegistry.prototype.get()",
				"MAIN_AGENT_ID",
			],
			[`${AGENT}/task/discovery`]: ["discoverAgents()"],
			[`${AGENT}/tools/builtin-names`]: ["BUILTIN_TOOL_NAMES", "HIDDEN_TOOL_NAMES"],
		},
	},
	themes: {
		modules: {
			"@oh-my-pi/pi-tui/theme": ["getResolvedThemeColors()"],
		},
	},
	settings: {
		// modelRegistry + roleCandidatePool + credentials: the automatic image-tool
		// switch (settings.ts; Setting override methods and onGeneration are feature-detected).
		session: [
			"settings",
			"model",
			"thinkingLevel",
			"modelRegistry.refreshInBackground()",
			"modelRegistry.awaitBackgroundRefresh()",
			"modelRegistry.authStorage.credentials.reload()",
		],
		modules: {
			[`${AGENT}/config/all-settings`]: ["orderedSettings()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			"@oh-my-pi/pi-tui/overlays/settings-defs": ["SETTING_TABS", "TAB_GROUPS", "TAB_METADATA"],
			[UTILS]: ["getAgentDir()", "MAIN_CONFIG_FILENAMES"],
		},
	},
	models: {
		session: [
			"getAvailableModels()",
			"modelRegistry.authStorage.credentials.reload()",
			"modelRegistry.refreshInBackground()",
			"modelRegistry.awaitBackgroundRefresh()",
		],
	},
	providers: {
		session: [
			"sessionId",
			"settings",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.credentials.reload()",
			"modelRegistry.authStorage.keys.source()",
			"modelRegistry.authStorage.oauth.identity()",
			"modelRegistry.getProviderBaseUrl()",
		],
		modules: {
			"@oh-my-pi/pi-ai/oauth": ["getOAuthProviders()", "getOAuthCredentialProvider()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/slash-commands/helpers/logout`]: ["listLogoutAccounts()", "logoutCredential()"],
			// The Updates section's tool CLIs read the connected providers in the stock helper (accounts.providers);
			// the first-run step asks whether any credential exists at all (accounts.signedIn).
			[`${AGENT}/sdk`]: ["discoverAuthStorage()"],
			"@oh-my-pi/pi-ai": ["listProvidersWithEnvKey()", "getEnvApiKey()"],
		},
	},
	modelRoles: {
		session: [
			"model",
			"modelRegistry",
			"modelRegistry.getAll()",
			"settings.getModelRole()",
			"settings.getModelRoleSource()",
			"settings.setModelRole()",
			"settings.flush()",
			// OMPdesk's own roles and agent tiers (ompdesk-roles.ts), held in the runtime layer, never persisted.
			"settings.overrideModelRoles()",
			"settings.overlayLayers()",
			"settings.getGlobalModelRole()",
			"settings.getProjectModelRole()",
			"settings.getGlobalSettings()",
			"settings.getProjectSettings()",
			"effectiveExtensionRoots",
		],
		modules: {
			[`${AGENT}/config/model-roles`]: [
				"getRoleInfo()",
				"roleCandidatePool()",
				"MODEL_ROLE_IDS",
				"CHAT_MODEL_ROLE_IDS",
			],
			[`${AGENT}/config/model-resolver`]: [
				"disabledProviderIds()",
				"extractExplicitThinkingSelector()",
				"resolveModelOverride()",
				"resolveRoleChain()",
				"resolveRoleSelection()",
				"rolePriorityDefaults()",
			],
			"@oh-my-pi/pi-catalog/types": ["modelKind()"],
			[`${AGENT}/config/registry`]: [
				"lookup()",
				"Setting.prototype.override()",
				"Setting.prototype.clearOverride()",
				// The `modelPresets` handle's writes drop the roles OMPdesk holds (ompdesk-roles.ts).
				"Setting.prototype.setEntry()",
				// A `/modelpreset switch` clears held roles; a `modelRoles` change re-holds them (ompdesk-roles.ts).
				"Setting.prototype.listen()",
			],
			// The security reviewer's tier holds only while stock's bundled agent has no model line.
			[`${AGENT}/task/agents`]: ["getBundledAgent()"],
			[`${AGENT}/task/discovery`]: ["discoverAgents()", "getAgent()"],
		},
	},
	modelSetupFacts: {
		// model_setup_facts (model-setup-facts.ts): billing from stock's auth data, the models of every role's pool,
		// what config.yml persists per role (`getGlobalModelRole`: its absence would let full auto overwrite a hand-set
		// role, so it is required, not feature-detected) and stock's judge defaults. session_spend: the live journal's
		// spend per provider with that billing (work board: a metered charge apart from a subscription's estimate).
		session: [
			"settings.getGlobalModelRole()",
			"sessionManager.getEntries()",
			"modelRegistry",
			"modelRegistry.getAll()",
			"modelRegistry.getDiscoverableProviders()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.keys.source()",
			"modelRegistry.authStorage.keys.keyless()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["getEnvApiKey()", "getProviderDefinition()"],
			"@oh-my-pi/pi-catalog/types": ["modelKind()"],
			[`${AGENT}/config/model-resolver`]: ["resolveModelOverride()", "rolePriorityDefaults()"],
			[`${AGENT}/config/model-roles`]: [
				"getKnownRoleIds()",
				"getRoleInfo()",
				"roleCandidatePool()",
				"MODEL_ROLE_IDS",
			],
			[`${AGENT}/config/models-config`]: ["ModelsConfigFile.relocate()"],
		},
	},
	usage: {
		// usage + provider_accounts (settings.ts): per-account quota, health and the session's pinned account;
		// `refresh` is stock's `omp usage invalidate`, and every read keys stock's usage cache by the
		// provider's base URL, as fetchUsageReports, header ingestion and credential selection do.
		session: [
			"fetchUsageReports()",
			"sessionId",
			"model",
			"sessionManager.getUsageStatistics()",
			"sessionManager.getEntries()",
			"modelRegistry.authStorage.oauth.accounts()",
			"modelRegistry.authStorage.credentials.reload()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.health.model()",
			"modelRegistry.authStorage.usage.report()",
			"modelRegistry.authStorage.usage.invalidate()",
			"modelRegistry.getProviderBaseUrl()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["resolveUsedFraction()"],
			"@oh-my-pi/pi-ai/auth/usage-report": ["usageResetAtMs()"],
			"@oh-my-pi/pi-ai/oauth": ["getOAuthCredentialProvider()"],
			[`${AGENT}/slash-commands/helpers/active-oauth-account`]: [
				"reportMatchesActiveAccount()",
				"formatActiveAccountLabel()",
			],
		},
	},
	security: {
		session: [
			"getAgentId()",
			"asyncJobManager",
			"sessionId",
			"model",
			"settings",
			"modelRegistry.authStorage",
			"sessionManager.getCwd()",
		],
		modules: {
			"@oh-my-pi/pi-natives/vcs": ["git()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			// Operations through stock's tool, which holds the session's coordinator (`security/coordinator` is not
			// in omp's bundle: an import of it is a second copy with its own settings registry).
			[`${AGENT}/tools/security-scan`]: ["SecurityScanTool.prototype.execute()"],
			[`${AGENT}/security/store`]: [
				"SecurityStore.openForCwd()",
				"SecurityStore.prototype.listScans()",
				"SecurityStore.prototype.getBundle()",
				"SecurityStore.prototype.getFinding()",
				"SecurityStore.prototype.updateDisposition()",
			],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["security/validate-request.md"],
	},
	ssh: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/capability/ssh`]: ["sshCapability.id"],
			[`${AGENT}/discovery`]: ["loadCapability()", "reset()"],
			[`${AGENT}/ssh/config-writer`]: [
				"readSSHConfigFile()",
				"removeSSHHost()",
				"updateSSHHost()",
				"validateHostName()",
			],
			[`${AGENT}/ssh/connection-manager`]: [
				"ensureConnection()",
				"ensureHostInfo()",
				"getHostInfoForHost()",
				"invalidateHostMetadata()",
			],
			[`${AGENT}/ssh/utils`]: ["buildSshTarget()"],
			[UTILS]: ["$which()", "getSSHConfigPath()", "ptree.exec()"],
		},
	},
	voice: {
		session: ["settings", "modelRegistry"],
		modules: {
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/stt/asr-client`]: ["sttClient.transcribe()"],
			[`${AGENT}/stt/downloader`]: ["downloadSttModel()", "isSttModelCached()"],
			[`${AGENT}/stt/models`]: ["resolveSttModelSpec()"],
			[`${AGENT}/tts/models`]: ["DEFAULT_TTS_VOICE", "TTS_LOCAL_MODELS"],
			[`${AGENT}/tts/tts-client`]: ["ttsClient.synthesize()"],
			[`${AGENT}/tools/tts`]: ["resolveSpeechCandidates()"],
			[`${AGENT}/tts/wav`]: ["encodeWav()"],
		},
	},
	debug: {
		session: ["settings", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/tools/debug`]: ["DebugTool.prototype.execute()"],
		},
	},
	sessionTree: {
		session: [
			"navigateTree()",
			"isStreaming",
			"sessionManager.appendLabelChange()",
			"sessionManager.getLeafId()",
			"sessionManager.getSessionFile()",
			"sessionManager.getBranch()",
			"sessionManager.getCwd()",
			"sessionManager.getSessionDir()",
			"sessionManager.getEntries()",
			"sessionManager.getTree()",
			"sessionManager.getLabel()",
			"sessionManager.flush()",
		],
		modules: {
			[`${AGENT}/session/session-manager`]: [
				"SessionManager.open()",
				"SessionManager.prototype.createBranchedSession()",
				"SessionManager.prototype.getEntry()",
				"SessionManager.prototype.getBranch()",
				"SessionManager.prototype.getChildren()",
				"SessionManager.prototype.flush()",
				"SessionManager.prototype.close()",
				"SessionManager.prototype.getSessionId()",
			],
			[`${AGENT}/session/session-context`]: ["buildSessionContext()"],
			[`${AGENT}/session/turn-persistence`]: ["sessionMessagePersistenceKey()", "sameMessageContent()"],
			[`${AGENT}/session/session-pins`]: ["loadPinnedSessionIds()"],
			[`${AGENT}/utils/atomic-file`]: ["replaceFileAtomically()"],
			[UTILS]: ["getAgentDir()", "withFileLock()"],
		},
	},
	sessionImport: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/session/foreign-session-import`]: ["createForeignSessionStore()", "persistForeignSession()"],
			[`${AGENT}/session/session-loader`]: ["loadSessionFile()"],
			[`${AGENT}/session/session-manager`]: ["SessionManager.getDefaultSessionDir()"],
			[UTILS]: ["directoryExists()", "withFileLock()"],
		},
	},
	workspace: {
		session: [
			"isStreaming",
			"refreshBaseSystemPrompt()",
			"sessionManager.getCwd()",
			"sessionManager.getAdditionalDirectories()",
			"sessionManager.addWorkspaceDirectory()",
			"sessionManager.removeWorkspaceDirectory()",
		],
		modules: {
			[`${AGENT}/session/session-workspace`]: ["normalizeWorkspaceDirectory()"],
			[`${AGENT}/tools/path-utils`]: ["resolveToCwd()"],
			// The sidebar's "Move to project" moves a stored session in the stock helper.
			[`${AGENT}/session/session-manager`]: [
				"SessionManager.open()",
				"SessionManager.prototype.moveTo()",
				"SessionManager.prototype.getSessionFile()",
				"SessionManager.prototype.close()",
			],
		},
	},
	inputHistory: {
		session: ["sessionManager.getSessionId()"],
		modules: {
			[`${AGENT}/session/history-storage`]: [
				"HistoryStorage.open()",
				"HistoryStorage.prototype.getRecent()",
				"HistoryStorage.prototype.search()",
				"HistoryStorage.prototype.add()",
			],
			[`${AGENT}/modes/controllers/input-controller`]: ["shouldSkipHistory()"],
		},
	},
	/**
	 * modes/next-prompt.ts: a cheap request on stock's `smol` role (`resolveRoleChain` over `roleCandidatePool`, the
	 * session's credentials through `modelRegistry.resolver`, `completeSimple`); `runEphemeralTurn` cannot take another
	 * model. Reads of the todo, plan and goal state, the running async jobs (`getAsyncJobTree`), the usage ledger
	 * (`appendModelUsage`) and the loaded-extension list are feature-detected inside the module (they only enrich the
	 * request).
	 */
	nextPrompt: {
		session: [
			"messages",
			"settings",
			"isStreaming",
			"isCompacting",
			"queuedMessageCount",
			"sessionId",
			"modelRegistry.getApiKey()",
			"modelRegistry.resolver()",
			"sessionManager.getSessionId()",
			"sessionManager.getLeafId()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["completeSimple()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/modes/controllers/input-controller`]: ["shouldSkipHistory()"],
		},
	},
	/**
	 * modes/auto-title.ts: stock's own title machinery on the live session: `generateTitle` (the title model
	 * roles, `title-generator.ts`), `renameTitle` (`/rename` without a title: the card per `title.icons`),
	 * `SessionManager.setSessionName(name, source, trigger)` and the journal's `title_change` entries (the title's
	 * origin). `operatorTitleText` names what an operator message is about. The title language: the session's
	 * TITLE_SYSTEM.md slot (`titleSystemPrompt`, `setTitleSystemPrompt`) holds stock's own `title-system.md`
	 * (rendered with `prompt.render`) plus one language line; `title-card` splits a card off a title cut to length,
	 * and `title.icons` (`cfgTitleIcons`) says whether a fresh title drops the card stock's retitle kept. A title over
	 * the limits gets one retry on the `default` role's model (`roleCandidatePool`, `resolveRoleChain`, the session's
	 * credentials, `completeSimple`), its answer checked by stock's `normalizeGeneratedTitle`.
	 */
	autoTitle: {
		session: [
			"settings",
			"sessionId",
			"modelRegistry.getApiKey()",
			"modelRegistry.resolver()",
			"subscribe()",
			"sessionName",
			"generateTitle()",
			"renameTitle()",
			"titleSystemPrompt",
			"setTitleSystemPrompt()",
			"sessionManager.getSessionId()",
			"sessionManager.getSessionName()",
			"sessionManager.setSessionName()",
			"sessionManager.getEntries()",
			"sessionManager.titleSource",
			"sessionManager.titleRevision",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["completeSimple()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/tiny/text`]: ["normalizeGeneratedTitle()"],
			[`${AGENT}/session/messages`]: ["operatorTitleText()"],
			[`${AGENT}/utils/title-card`]: ["splitCardTitle()", "formatCardTitle()"],
			[`${AGENT}/utils/title-settings`]: ["cfgTitleIcons.get()"],
			[UTILS]: ["prompt.render()", "logger.info()"],
		},
		prompts: ["system/title-system.md"],
	},
	judgeAssist: {
		session: ["settings", "sessionId", "modelRegistry", "sessionManager", "messages"],
		modules: {
			"@oh-my-pi/pi-ai": ["nativeJudgmentImageBounds()"],
			[`${AGENT}/judgment`]: [
				"hasNativeJudge()",
				"resolveJudge()",
				"sharedJudgmentCache()",
				"journalJudgmentUsage()",
			],
		},
	},
	/**
	 * modes/memory-recall.ts: the public `before_agent_start` hook (its `message` result) and the main session for the
	 * judge (judge-assist-engine.ts `recallRelevance`, whose stock imports `judgeAssist` lists; without them the code
	 * rule chooses).
	 */
	memoryRecall: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
		session: ["settings", "sessionId", "modelRegistry", "sessionManager"],
	},
	autoMode: {
		session: [
			"settings",
			"sessionId",
			"model",
			"isStreaming",
			"messages",
			"getTodoPhases()",
			"getAsyncJobTree()",
			"modelRegistry",
			"agent.metadataForProvider()",
			"agent.telemetry",
			"sessionManager.getSessionId()",
			"getPlanModeState()",
			"getGoalModeState()",
			"setPlanModeState()",
		],
		modules: {
			[`${AGENT}/judgment`]: [
				"resolveJudge()",
				"sharedJudgmentCache()",
				"journalJudgmentUsage()",
				"hasNativeJudge()",
			],
			[`${AGENT}/tiny/message-preproc`]: ["preprocessTinyMessage()"],
			[`${AGENT}/plan-mode/settings`]: ["cfgPlanEnabled.get()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	compactionLimits: {
		session: ["settings", "getAvailableModels()", "modelRegistry.getAll()", "modelRegistry.getAvailable()"],
		modules: {
			[`${AGENT}/config/compaction-threshold`]: [
				"parseCompactionPointInput()",
				"validateModelCompactionThresholds()",
				"formatCompactionPointInput()",
			],
			[`${AGENT}/session/model-compaction-threshold`]: ["describeModelCompactionPoint()"],
			[`${AGENT}/modes/model-browser-source`]: ["createModelBrowserSource()"],
			"@oh-my-pi/pi-tui/overlays/model-browser": ["resolveRoleAssignments()"],
		},
	},
	/**
	 * idle-compaction.ts: the TUI's idle timer re-armed on the live session; stock does the work. `promptCacheEntry`
	 * (omp ≥ 18.12.2, when stock's own timer started compacting ahead of a 1-hour cache entry) is read when present;
	 * without it the timer keeps the configured delay, as stock's did.
	 */
	idleCompaction: {
		session: ["subscribe()", "settings", "isStreaming", "isCompacting", "getContextUsage()", "runIdleCompaction()"],
		modules: {
			[`${AGENT}/session/context-settings`]: ["cfgCompaction.get()"],
			[`${AGENT}/session/cache-warmer`]: ["getCacheWarmingDelayMs()"],
		},
	},
	/**
	 * session-recap.ts: the TUI's idle recap timer on the live session. Stock's own prompt
	 * (`prompts/system/recap-user.md`) and `runEphemeralTurn()` make the recap, `recordRecap()` journals it
	 * (history.db `session_recaps`); `recap.*` are read through `lookup`. The goal and the todo list only
	 * anchor the prompt and are feature-detected inside the module.
	 */
	sessionRecap: {
		session: [
			"subscribe()",
			"settings",
			"model",
			"messages",
			"isStreaming",
			"isCompacting",
			"runEphemeralTurn()",
			"sendCustomMessage()",
			"sessionManager.recordRecap()",
			"sessionManager.getSessionName()",
		],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/tools/todo`]: ["nextActionableTask()"],
			"@oh-my-pi/pi-tui/render/render-utils": ["previewLine()", "TRUNCATE_LENGTHS"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/recap-user.md"],
	},
	/** prompt-origin.ts: a host tab journals its device per user message (public `message_end` hook). */
	promptOrigin: {
		session: ["sessionManager.appendCustomEntry()", "sessionManager.getEntries()"],
	},
	/** context-inspect.ts: every tool, skill, context file, prompt block and message with stock's own estimators. */
	contextInspector: {
		session: [
			"getContextBreakdown()",
			"systemPrompt",
			"renderedSkills",
			"hasBuiltInTool()",
			"getXdevToolEntries()",
			"settings",
			"agent.state",
			"agent.tokenizer.countTokens()",
			"agent.tokenizer.countMessage()",
		],
		modules: {
			[`${AGENT}/session/messages`]: ["convertToLlm()"],
			"@oh-my-pi/pi-tui/status-line/context-usage": ["estimateToolSchemaTokens()", "estimateSkillsTokens()"],
			"@oh-my-pi/pi-ai/utils/schema": ["toolWireSchema()"],
		},
	},
	/** recent-models.ts: stock's most-recently-used model order, as the `/models` hub reads it. */
	recentModels: {
		session: ["settings", "settings.getStorage()"],
		modules: {
			[`${AGENT}/modes/model-browser-source`]: ["createModelBrowserSource()"],
			[`${AGENT}/session/agent-storage`]: ["AgentStorage.prototype.getModelUsageOrder()"],
		},
	},
	accountPools: {
		// provider_accounts (settings.ts): each account's token-free identity key, the
		// string `task.agentAccountPools` matches.
		modules: {
			"@oh-my-pi/pi-ai": ["resolveCredentialIdentityKey()"],
		},
	},
	worktreeLifecycle: {
		// worktree-lifecycle.ts: the `worktree.onStart` / `worktree.onExit` settings and
		// stock's start condition and creation for them. stock-helper/worktrees.ts reads the same worktree
		// location without a session (`worktree.base` read-only, applied as stock's effect does) for a worktree
		// a paired device's agent makes here.
		session: ["settings", "sessionManager.getCwd()", "sessionManager.getSessionFile()"],
		modules: {
			[`${AGENT}/task/settings`]: ["cfgWorktreeOnStart.get()", "cfgWorktreeOnExit.get()", "cfgWorktreeBase.get()"],
			[`${AGENT}/config/settings`]: ["Settings.loadReadOnly()"],
			[`${AGENT}/session/session-worktree`]: [
				"canAutoCreateWorktree()",
				"createSessionWorktree()",
				"defaultSessionWorktreeBranch()",
			],
			[`${AGENT}/tools/gh-pr-checkout`]: ["checkoutPullRequest()"],
			[UTILS]: ["getWorktreesDir()", "hashPath()", "setWorktreesDir()"],
		},
	},
	resetPasses: {
		// reset-passes.ts (redeem) + the passes on usage / provider_accounts (settings.ts):
		// stock's saved-reset listing, `/usage reset` helpers and redeem.
		session: ["listResetCredits()", "redeemResetCredit()"],
		modules: {
			"@oh-my-pi/pi-ai/oauth": ["getOAuthCredentialProvider()"],
			[`${AGENT}/slash-commands/helpers/reset-usage`]: ["toResetUsageAccounts()", "describeRedeemOutcome()"],
		},
	},
	phoneImages: {
		// stock-helper/images.ts `image.toModel`: a phone's HEIC/HEIF made model-safe with stock's image path.
		session: [],
		modules: {
			"@oh-my-pi/pi-tui/chat/image-loading": ["ensureSupportedImageInput()"],
			[`${AGENT}/utils/image-resize`]: ["resizeImage()"],
		},
	},
};

export const ALL_FEATURES = Object.keys(FEATURES) as FeatureId[];

/** Whether `path` resolves on `root` (see the module comment for the path syntax). Throwing getters count as missing. */
export function hasPath(root: unknown, path: string): boolean {
	const callable = path.endsWith("()");
	const segments = (callable ? path.slice(0, -2) : path).split(".");
	const last = segments.pop() ?? "";
	const isObjectLike = (value: unknown): value is object =>
		(typeof value === "object" && value !== null) || typeof value === "function";
	try {
		let owner: unknown = root;
		for (const segment of segments) {
			if (!isObjectLike(owner)) return false;
			owner = (owner as Record<string, unknown>)[segment];
		}
		if (!isObjectLike(owner)) return false;
		return callable ? typeof (owner as Record<string, unknown>)[last] === "function" : last in owner;
	} catch {
		return false;
	}
}

/** omp's scheme for a bridge import it serves from the running omp's own bundle (`extensibility/plugins/legacy-pi-compat.ts`). */
export const BUNDLED_SCHEME = "omp-legacy-pi-bundled:";

/**
 * Stock modules the bridge may load as a separate copy, each with why that is harmless.
 *
 * omp rewrites a bridge's `@oh-my-pi/*` import onto the running omp's module only when its bundle registers that
 * subpath; any other subpath falls back to the package's source file, a second module graph with its own settings
 * registry, settings singleton and module state. A copy's setting handles read other settings' slots of the live
 * session (`goal.enabled` read `[]` on omp 18.12.2), so a copy is allowed only when it reads no setting and the
 * bridge needs none of its state shared with the session. Anything else goes through a bundled module (the registry's
 * `lookup`, a package root, a stock tool), and a new copy fails bridge-stock-settings-stock.test.ts.
 */
export const COPY_SAFE: Readonly<Record<string, string>> = {
	"@oh-my-pi/pi-ai/auth/blocks": "block-scope constants and key helpers: no setting, no state",
	"@oh-my-pi/pi-ai/auth/rank": "the usage-ranking comparator: pure, imports nothing",
	"@oh-my-pi/pi-ai/auth/usage-report": "usage-window arithmetic: pure",
	[`${AGENT}/autolearn/managed-skills`]:
		"only the provider id and the name sanitizer (pure); writes go through stock's `manage_skill` tool, never the copy's own per-skill mutation chain",
	[`${AGENT}/config`]:
		"the `.omp` config dirs only: the copy's provider switches are unbound defaults and `.omp` is never a switchable foreign provider",
	[`${AGENT}/sdk`]: "presence probe only: the stock helper loads it from omp's package in its own process",
	[`${AGENT}/security/store`]: "scan files on disk under stock's file lock: no setting",
	[`${AGENT}/skillshare/client`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/skillshare/installer`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/skillshare/manifest`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/tiny/message-preproc`]: "text cleanup: pure",
	[`${AGENT}/tiny/text`]: "title text helpers: pure",
	[`${AGENT}/tts/models`]: "the local voice and model tables: data",
	[`${AGENT}/tts/tts-client`]:
		"NOT harmless, kept for want of a route: omp's bundle has no `tts/*` at all and only stock's `tts` tool reaches its client, falling through to cloud voices the speech role lists (read-aloud stays local). The copy runs its own worker and, uninitialised, takes the tiny-model device and dtype from the environment instead of `providers.tinyModel*` (needs `tts/*` in omp's bundle upstream)",
	[`${AGENT}/tts/wav`]: "the WAV encoder: pure",
};

/**
 * Source copies whose first import makes bun transpile a large part of omp's source tree inside the omp process,
 * measured on Windows (omp 18.12.3, bun 1.4.3, warm cache): `config` and `tts/*` ~540 ms of omp's only thread, `sdk` and
 * `skillshare/*` another ~600 ms; with a cold transpiler cache the same loads took 4 to 6 s before omp's `ready`. The
 * startup `capabilities` probe leaves them unevaluated (`ProbeSources.unloaded`); `guard` still evaluates a feature's
 * modules on its first call. Each is in COPY_SAFE.
 */
export const HEAVY_COPIES: Readonly<Record<string, string>> = {
	[`${AGENT}/config`]: "extensions/agents.ts loads it on use",
	[`${AGENT}/sdk`]: "presence probe only",
	[`${AGENT}/skillshare/client`]: "presence probe only",
	[`${AGENT}/skillshare/installer`]: "presence probe only",
	[`${AGENT}/skillshare/manifest`]: "presence probe only",
	[`${AGENT}/tts/models`]: "voice.ts loads it on use",
	[`${AGENT}/tts/tts-client`]: "voice.ts loads it on use",
	[`${AGENT}/tts/wav`]: "voice.ts loads it on use",
};

/**
 * Specifiers whose loader reached a separate copy, from each loader's import target as omp rewrote it. On an omp run
 * from source nothing is bundled and every import shares one graph, so nothing counts as a copy there.
 */
export function separateCopies(targets: Readonly<Record<string, string>>): string[] {
	const entries = Object.entries(targets);
	if (!entries.some(([, target]) => target.startsWith(BUNDLED_SCHEME))) return [];
	return entries.filter(([, target]) => !target.startsWith(BUNDLED_SCHEME)).map(([specifier]) => specifier);
}

/** The copies a probe refuses: every separate copy not in COPY_SAFE. */
export function unsafeCopies(targets: Readonly<Record<string, string>>): Set<string> {
	return new Set(separateCopies(targets).filter(specifier => !(specifier in COPY_SAFE)));
}

/** What a probe reads; fakes in tests, live omp objects in health.ts. */
export interface ProbeSources {
	/** The live AgentSession; `undefined` skips session requirements (none attached yet). */
	session: unknown;
	/** omp's package index (`env.pi.pi`). */
	pkg: unknown;
	/** Imported module namespaces by specifier; an absent key means the import failed. */
	modules: ReadonlyMap<string, unknown>;
	hasPrompt(relative: string): boolean;
	/** Labels reported missing even when present (`OMP_GUI_BRIDGE_PROBE_HIDE`). */
	hidden?: ReadonlySet<string>;
	/** Specifiers that loaded a separate copy of stock, not the running omp's module (`unsafeCopies`). */
	copies?: ReadonlySet<string>;
	/**
	 * Specifiers a probe left unevaluated because their file is there and loading it is costly (`HEAVY_COPIES`): present
	 * for this check, verified by the first guarded call that needs them.
	 */
	unloaded?: ReadonlySet<string>;
}

const label = (owner: string, path: string) => `${owner}${path.endsWith("()") ? path.slice(0, -2) : path}`;

/** Missing labels for one requirement: `AgentSession.x`, `pi.x`, `<specifier>#x`, `<specifier>`, `prompts/<file>`. */
export function missingFor(requirement: FeatureRequirement, sources: ProbeSources): string[] {
	const missing: string[] = [];
	const check = (present: boolean, name: string) => {
		if (!present || sources.hidden?.has(name)) missing.push(name);
	};
	if (sources.session !== undefined) {
		for (const path of requirement.session ?? []) {
			check(hasPath(sources.session, path), label("AgentSession.", path));
		}
	}
	for (const path of requirement.pkg ?? []) check(hasPath(sources.pkg, path), label("pi.", path));
	for (const [specifier, paths] of Object.entries(requirement.modules ?? {})) {
		if (sources.copies?.has(specifier)) {
			missing.push(`${specifier} (separate copy, not this omp's module)`);
			continue;
		}
		if (sources.unloaded?.has(specifier)) continue;
		if (!sources.modules.has(specifier)) {
			missing.push(specifier);
			continue;
		}
		const namespace = sources.modules.get(specifier);
		for (const path of paths) check(hasPath(namespace, path), label(`${specifier}#`, path));
	}
	for (const prompt of requirement.prompts ?? []) check(sources.hasPrompt(prompt), `prompts/${prompt}`);
	return missing;
}

/** Features (in `features` order) with at least one missing requirement. */
export function deriveUnavailable(
	features: readonly FeatureId[],
	sources: ProbeSources,
	requirements: Readonly<Partial<Record<FeatureId, FeatureRequirement>>> = REQUIREMENTS,
): UnavailableFeature[] {
	const unavailable: UnavailableFeature[] = [];
	for (const feature of features) {
		const requirement = requirements[feature];
		if (!requirement) continue;
		const missing = missingFor(requirement, sources);
		if (missing.length > 0) unavailable.push({ feature, missing });
	}
	return unavailable;
}

/** A bridge module (index.ts `AREAS`) whose import threw, e.g. a removed static export. */
export interface AreaFailure {
	area: string;
	features: readonly FeatureId[];
	error: string;
}

/** Every feature a failed module serves is unavailable, whatever the probe saw. */
export function mergeAreaFailures(
	unavailable: readonly UnavailableFeature[],
	failures: readonly AreaFailure[],
): UnavailableFeature[] {
	const merged = new Map<FeatureId, string[]>(unavailable.map(entry => [entry.feature, [...entry.missing]]));
	for (const failure of failures) {
		const note = `gui-bridge/${failure.area}.ts failed to load: ${failure.error}`;
		for (const feature of failure.features) {
			const missing = merged.get(feature) ?? [];
			if (!missing.includes(note)) missing.push(note);
			merged.set(feature, missing);
		}
	}
	return [...merged].map(([feature, missing]) => ({ feature, missing }));
}

/** `OMP_GUI_BRIDGE_PROBE_HIDE`: comma-separated missing labels to simulate (diagnostics and tests). */
export function parseHidden(raw: string | undefined): ReadonlySet<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map(entry => entry.trim())
			.filter(Boolean),
	);
}

/** Thrown where a missing omp internal is hit; index.ts forwards `code` to the GUI. */
export class UnsupportedOmpError extends Error {
	readonly code = "unsupported_omp";
	readonly unavailable: readonly UnavailableFeature[];

	constructor(unavailable: readonly UnavailableFeature[], ompVersion?: string) {
		const parts = unavailable.map(entry => `${FEATURES[entry.feature]} (missing ${entry.missing.join(", ")})`);
		super(
			`Unavailable with ${ompVersion ? `omp ${ompVersion}` : "this omp"}: ${parts.join("; ")}. ` +
				"Update omp (`omp update`) or the GUI, or report an issue if it persists.",
		);
		this.name = "UnsupportedOmpError";
		this.unavailable = unavailable;
	}
}

/** Fail with `unsupported_omp` unless `owner.<path>` is a function (`ownerLabel` names `owner` in the error). */
export function requireFn(owner: unknown, path: string, feature: FeatureId, ownerLabel = "AgentSession"): void {
	if (!hasPath(owner, `${path}()`)) throw new UnsupportedOmpError([{ feature, missing: [`${ownerLabel}.${path}`] }]);
}
