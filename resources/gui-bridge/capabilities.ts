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
	btw: "/btw side questions",
	loopMode: "Loop mode",
	vibeMode: "Vibe mode",
	goalMode: "Goal mode",
	tan: "/tan background tangents",
	omfg: "/omfg rule forging",
	agentPause: "Agent pause",
	modelPool: "Model pool",
	mcp: "MCP servers",
	plugins: "Plugins & marketplaces",
	skills: "Skills, hooks & prompt templates",
	agents: "Agent definitions & memory",
	themes: "Themes",
	settings: "Settings",
	models: "Model catalog",
	providers: "Providers & logout",
	modelRoles: "Model roles",
	usage: "Usage",
	security: "Security scans",
	ssh: "SSH hosts",
	voice: "Voice input & speech",
	debug: "Debug console",
	sessionTree: "Session tree, labels & pins",
	sessionImport: "Claude/Codex session import",
	workspace: "Workspace directories",
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
		pkg: ["VERSION", "AgentRegistry.global()", "MAIN_AGENT_ID"],
	},
	composer: {
		session: [
			"getActiveToolNames()",
			"toolChoiceQueue.pushSequence()",
			"toolChoiceQueue.removeByLabel()",
			"getPrewalkState()",
			"executePython()",
			"abortEval()",
			"executeBash()",
			"resetSessionContext()",
			"getContextBreakdown()",
			"getAsyncJobSnapshot()",
			"cycleModel()",
			"popLastQueuedMessage()",
			"getQueuedMessages()",
			"agent.state",
			"settings",
			"sessionManager.getCwd()",
			"sessionManager.getArtifactsDir()",
			"sessionManager.getSessionId()",
		],
		modules: {
			[`${AGENT}/utils/tool-choice`]: ["buildNamedToolChoice()"],
			[`${AGENT}/session/settings`]: [
				"cfgPrewalkEnabled.get()",
				"cfgPrewalkEnabled.override()",
				"cfgPrewalkEnabled.clearOverride()",
			],
			[`${AGENT}/internal-urls/local-protocol`]: ["resolveLocalRoot()"],
			[`${AGENT}/slash-commands/builtin-completions`]: [
				"buildArgumentCompletions()",
				"buildDirectoryArgumentCompletions()",
			],
			[`${AGENT}/slash-commands/builtin-registry`]: ["BUILTIN_SLASH_COMMANDS_INTERNAL"],
			[`${AGENT}/mcp/config-writer`]: ["readMCPConfigFile()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
			[UTILS]: ["isEexist()", "getMCPConfigPath()"],
		},
	},
	share: {
		session: ["state", "obfuscator", "settings", "sessionManager"],
		modules: {
			[`${AGENT}/export/share`]: ["buildShareSnapshot()", "normalizeShareServerUrl()", "shareSession()"],
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
			"getVibeModeState()",
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
			["@oh-my-pi/pi-tui/tools/resolve"]: ["PROPOSE_DEVICE_NAME"],
			[`${AGENT}/internal-urls`]: ["copyLocalArtifacts()", "resolveLocalUrlToPath()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/plan-mode-compact-instructions.md", "system/plan-mode-approved.md"],
	},
	btw: {
		session: [
			"subscribe()",
			"runEphemeralTurn()",
			"model",
			"sessionManager.getArtifactsDir()",
			"sessionManager.getSessionId()",
			"sessionManager.getLeafId()",
			"sessionManager.ensureOnDisk()",
		],
		modules: {
			[`${AGENT}/session/btw-history`]: [
				"BtwHistoryStore.open()",
				"BtwHistoryStore.prototype.upsert()",
				"BtwHistoryStore.prototype.retry()",
				"getBtwLatestTurn()",
				"getBtwTurns()",
			],
			[UTILS]: ["prompt.render()", "Snowflake.next()"],
		},
		prompts: ["system/btw-user.md"],
	},
	loopMode: {
		session: [
			"subscribe()",
			"prompt()",
			"followUp()",
			"compact()",
			"newSession()",
			"getEnabledToolNames()",
			"getVibeModeState()",
			"isStreaming",
			"isCompacting",
			"hasPostPromptWork",
			"settings",
			"sessionManager.getCwd()",
			"sessionManager.getSessionId()",
		],
		modules: {
			[`${AGENT}/modes/loop-condition`]: ["evaluateLoopCondition()"],
			[`${AGENT}/modes/loop-limit`]: [
				"createLoopLimitRuntime()",
				"parseLoopArgs()",
				"isLoopDurationExpired()",
				"consumeLoopLimitIteration()",
				"isLoopLimitExhausted()",
			],
			[`${AGENT}/modes/settings`]: ["cfgLoopMode.get()", "cfgLoopConditionTimeoutMs.get()"],
		},
	},
	vibeMode: {
		session: [
			"subscribe()",
			"getPlanModeState()",
			"getGoalModeState()",
			"getVibeModeState()",
			"setVibeModeState()",
			"getEnabledToolNames()",
			"hasBuiltInTool()",
			"activateVibeTools()",
			"deactivateVibeTools()",
			"removeVibeToolsPreservingActive()",
			"runModeExitTeardown()",
			"sendVibeModeContext()",
			"abort()",
			"getAgentId()",
			"asyncJobManager",
			"isStreaming",
			"sessionManager.appendModeChange()",
			"sessionManager.getSessionId()",
			"sessionManager.getSessionFile()",
		],
		modules: {
			[`${AGENT}/config/model-resolver`]: ["formatModelStringWithRouting()"],
			[`${AGENT}/vibe/runtime`]: [
				"VibeSessionRegistry.global()",
				"VibeSessionRegistry.prototype.ownerScope()",
				"VibeSessionRegistry.prototype.activateScope()",
				"VibeSessionRegistry.prototype.killAll()",
			],
		},
	},
	goalMode: {
		session: [
			"subscribe()",
			"getGoalModeState()",
			"setGoalModeState()",
			"getPlanModeState()",
			"getVibeModeState()",
			"getEnabledToolNames()",
			"setActiveToolsByName()",
			"sendGoalModeContext()",
			"prompt()",
			"followUp()",
			"isStreaming",
			"goalRuntime.replaceGoal()",
			"goalRuntime.onBudgetMutated()",
		],
		modules: {
			[`${AGENT}/goals/settings`]: ["cfgGoalEnabled.get()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["goals/guided-goal-interview.md"],
	},
	tan: {
		session: ["sessionManager", "settings"],
		modules: {
			[`${AGENT}/modes/controllers/tan-command-controller`]: ["TanCommandController.prototype.start()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
		},
	},
	omfg: {
		session: [
			"runEphemeralTurn()",
			"ruleJudge()",
			"messages",
			"agent.state",
			"ttsrManager",
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
			["@oh-my-pi/pi-agent-core"]: ["agentPauseGate.pause()", "agentPauseGate.resume()", "agentPauseGate.pausedAt"],
		},
	},
	modelPool: {
		session: [
			"getEnabledToolNames()",
			"sessionManager.getBranch()",
			"sessionManager.appendCustomEntry()",
		],
	},
	mcp: {
		session: [
			"setMCPPromptCommands()",
			"getEvalPreludes()",
			"refreshMCPTools()",
			"effectiveExtensionRoots",
			"settings",
			"sessionManager.getCwd()",
			"modelRegistry.authStorage.credentials.set()",
		],
		modules: {
			[`${AGENT}/capability/fs`]: ["clearCache()"],
			[`${AGENT}/discovery/helpers`]: ["expandEnvVarsDeep()"],
			[`${AGENT}/mcp/client`]: ["connectToServer()", "disconnectServer()", "listTools()"],
			[`${AGENT}/mcp/config`]: ["loadAllMCPConfigs()", "validateServerConfig()"],
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
			[`${AGENT}/mcp/oauth-flow`]: ["MCPOAuthFlow()", "mcpOAuthCredentialId()"],
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
			[`${AGENT}/extensibility/plugins/loader`]: ["getEnabledPlugins()"],
			[`${AGENT}/extensibility/plugins/manager`]: [
				"validateSetting()",
				"PluginManager.prototype.list()",
				"PluginManager.prototype.getPlugin()",
				"PluginManager.prototype.setEnabled()",
				"PluginManager.prototype.getPluginSettings()",
				"PluginManager.prototype.setEnabledFeatures()",
				"PluginManager.prototype.setPluginSetting()",
				"PluginManager.prototype.deletePluginSetting()",
			],
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
			],
			[UTILS]: ["pathIsWithin()"],
		},
	},
	skills: {
		session: [
			"skills",
			"skillsSettings",
			"promptTemplates",
			"effectiveExtensionRoots",
			"refreshSkills()",
			"settings.flush()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/capability`]: ["loadCapability()"],
			[`${AGENT}/capability/hook`]: ["hookCapability.id"],
			[`${AGENT}/autolearn/managed-skills`]: [
				"deleteManagedSkill()",
				"MANAGED_SKILLS_PROVIDER_ID",
				"sanitizeSkillName()",
				"writeManagedSkill()",
			],
			[`${AGENT}/config/prompt-templates`]: ["templateUsesInlineArgPlaceholders()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/extensibility/skills`]: ["loadSkills()"],
			[UTILS]: ["parseFrontmatter()"],
		},
	},
	agents: {
		session: [
			"effectiveExtensionRoots",
			"model",
			"modelRegistry",
			"settings.getModelRole()",
			"settings.getAgentDir()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/config`]: ["getConfigDirs()", "findAllNearestProjectConfigDirs()"],
			[`${AGENT}/config/model-resolver`]: [
				"formatModelString()",
				"resolveAgentModelPatterns()",
				"resolveAgentPrewalkPattern()",
				"resolveModelOverride()",
			],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/memory-backend/resolve`]: ["resolveMemoryBackend()"],
			[`${AGENT}/registry/agent-lifecycle`]: ["AgentLifecycleManager.global()"],
			[`${AGENT}/registry/agent-registry`]: ["AgentRegistry.global()", "MAIN_AGENT_ID"],
			[`${AGENT}/task/discovery`]: ["discoverAgents()"],
			[`${AGENT}/task/prewalk`]: ["resolveAgentPrewalkDefault()"],
			[`${AGENT}/tools/builtin-names`]: ["BUILTIN_TOOL_NAMES", "HIDDEN_TOOL_NAMES"],
		},
	},
	themes: {
		modules: {
			["@oh-my-pi/pi-tui/theme"]: ["getAvailableThemesWithPaths()", "getResolvedThemeColors()"],
		},
	},
	settings: {
		session: ["settings", "model", "thinkingLevel"],
		modules: {
			[`${AGENT}/config/all-settings`]: ["orderedSettings()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			["@oh-my-pi/pi-tui/overlays/settings-defs"]: ["SETTING_TABS", "TAB_GROUPS", "TAB_METADATA"],
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
			"modelRegistry.authStorage.credentials.remove()",
			"modelRegistry.authStorage.keys.source()",
			"modelRegistry.authStorage.oauth.identity()",
			"modelRegistry.getProviderBaseUrl()",
			"modelRegistry.refreshProvider()",
		],
		modules: {
			["@oh-my-pi/pi-ai/oauth"]: ["getOAuthProviders()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	modelRoles: {
		session: [
			"modelRegistry",
			"settings.getModelRole()",
			"settings.getModelRoleSource()",
			"settings.setModelRole()",
			"settings.flush()",
		],
		modules: {
			[`${AGENT}/config/model-roles`]: ["getKnownRoleIds()", "getRoleInfo()", "roleCandidatePool()"],
			["@oh-my-pi/pi-catalog/types"]: ["modelKind()"],
		},
	},
	usage: {
		session: [
			"fetchUsageReports()",
			"sessionId",
			"model",
			"sessionManager.getUsageStatistics()",
			"modelRegistry.authStorage.oauth.identity()",
		],
		modules: {
			["@oh-my-pi/pi-ai"]: ["resolveUsedFraction()"],
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
			["@oh-my-pi/pi-natives/vcs"]: ["git()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/security/coordinator`]: ["getSecurityCoordinator()"],
			[`${AGENT}/security/store`]: [
				"SecurityStore.openForCwd()",
				"SecurityStore.prototype.listScans()",
				"SecurityStore.prototype.getBundle()",
				"SecurityStore.prototype.getFinding()",
				"SecurityStore.prototype.updateDisposition()",
			],
		},
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
			[UTILS]: ["$which()", "getSSHConfigPath()"],
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
			[`${AGENT}/tts/models`]: ["DEFAULT_TTS_VOICE"],
			[`${AGENT}/tts/tts-client`]: ["ttsClient.synthesize()"],
			[`${AGENT}/tts/vocalizer`]: ["resolveLocalSpeechModelId()"],
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
			"sessionManager.getAdditionalDirectories()",
			"sessionManager.getLabel()",
			"sessionManager.getSessionName()",
		],
		modules: {
			[`${AGENT}/session/session-manager`]: [
				"copySessionArtifacts()",
				"SessionManager.create()",
				"SessionManager.prototype.newSession()",
				"SessionManager.prototype.ingestReplicatedEntry()",
				"SessionManager.prototype.appendLabelChange()",
				"SessionManager.prototype.setSessionName()",
				"SessionManager.prototype.flush()",
				"SessionManager.prototype.close()",
				"SessionManager.prototype.getSessionFile()",
				"SessionManager.prototype.getSessionId()",
			],
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
