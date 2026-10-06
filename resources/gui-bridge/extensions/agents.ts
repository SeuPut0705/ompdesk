/**
 * Agent definitions, subagent revive, memory backend report, and TUI themes.
 * Ported from the omp-gui fork's rpc-agents / rpc-domains / rpc-mode theme
 * cases onto stock omp internals.
 */
import {
	formatModelString,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveAgentPrewalkDefault } from "@oh-my-pi/pi-coding-agent/task/prewalk";
import { getAvailableThemesWithPaths, getResolvedThemeColors } from "@oh-my-pi/pi-tui/theme";
import type { BridgeMethods } from "../types";
import { errorMessage, paramsOf, readSetting, requireString } from "./shared";

export const methods: BridgeMethods = {
	/** Workspace-visible definitions plus the TUI control center's model/prewalk projection. */
	get_agent_definitions: async (_params, env) => {
		const session = env.session();
		const { agents } = await discoverAgents(
			session.sessionManager.getCwd(),
			undefined,
			session.effectiveExtensionRoots,
		);
		const activeModelPattern = session.model ? formatModelString(session.model) : undefined;
		const fallbackModelPattern = session.settings.getModelRole("default");
		const modelOverrides = readSetting<Record<string, string>>(session, "task.agentModelOverrides") ?? {};
		const prewalkOverrides = readSetting<Record<string, string>>(session, "task.agentPrewalk") ?? {};
		const taskPrewalk = readSetting<boolean>(session, "task.prewalk") ?? false;
		const resolve = (patterns: string[]) => {
			const result = resolveModelOverride(patterns, session.modelRegistry, session.settings);
			return {
				model: result.model ? formatModelString(result.model) : undefined,
				thinkingLevel: result.thinkingLevel,
			};
		};
		return {
			agents: agents.map(agent => {
				const base = {
					agentModel: agent.model,
					settings: session.settings,
					activeModelPattern,
					fallbackModelPattern,
				};
				const defaultPatterns = resolveAgentModelPatterns(base);
				const effectivePatterns = resolveAgentModelPatterns({
					...base,
					settingsOverride: modelOverrides[agent.name],
				});
				const effective = resolve(effectivePatterns);
				const prewalkPattern = resolveAgentPrewalkPattern({
					settingsOverride: prewalkOverrides[agent.name],
					agentPrewalk: resolveAgentPrewalkDefault(agent, taskPrewalk),
				});
				return {
					name: agent.name,
					description: agent.description,
					source: agent.source,
					filePath: agent.filePath,
					model: agent.model,
					thinkingLevel: agent.thinkingLevel,
					tools: agent.tools,
					spawns: agent.spawns,
					autoloadSkills: agent.autoloadSkills,
					output: agent.output,
					blocking: agent.blocking,
					readSummarize: agent.readSummarize,
					prewalk: agent.prewalk,
					defaultPatterns,
					defaultResolved: resolve(defaultPatterns).model,
					effectivePatterns,
					effectiveResolved: effective.model,
					effectiveThinkingLevel: effective.thinkingLevel,
					prewalkPattern,
					prewalkResolved: prewalkPattern ? resolve([prewalkPattern]).model : undefined,
				};
			}),
		};
	},

	/** AgentLifecycleManager.ensureLive: idempotent for live agents, revives parked ones (Agent Hub `r`). */
	revive_subagent: async params => {
		const agentId = requireString(paramsOf(params), "agentId");
		if (agentId === MAIN_AGENT_ID) return { ok: false, reason: "main_agent" };
		const ref = AgentRegistry.global().get(agentId);
		if (!ref) return { ok: false, reason: "not_found" };
		if (ref.kind === "advisor") return { ok: false, reason: "advisor_readonly" };
		try {
			await AgentLifecycleManager.global().ensureLive(agentId);
			return { ok: true };
		} catch {
			// Aborted/tombstoned refs and refs never adopted have no reviver.
			return { ok: false, reason: "not_parked" };
		}
	},

	/** Active backend, structured status, and the `/memory stats` / `/memory diagnose` markdown; each hook best-effort. */
	get_memory_report: async (_params, env) => {
		const session = env.session();
		const backend = await resolveMemoryBackend(session.settings);
		const agentDir = session.settings.getAgentDir();
		const cwd = session.sessionManager.getCwd();
		const report: Record<string, unknown> = { backend: backend.id };
		const warn = (hook: string, error: unknown) =>
			env.pi.logger.warn(`gui-bridge get_memory_report: backend ${hook} failed`, { error: errorMessage(error) });
		if (backend.status) {
			try {
				const status = await backend.status({ agentDir, cwd, session });
				report.status = {
					active: status.active,
					writable: status.writable,
					searchable: status.searchable,
					scope: status.scope,
					retainBank: status.retainBank,
					recallBanks: status.recallBanks ? [...status.recallBanks] : undefined,
					workingCount: status.workingCount,
					episodicCount: status.episodicCount,
					tripleCount: status.tripleCount,
					lastMemory: status.lastMemory,
					lastRecall: status.lastRecall,
					database: status.database,
					message: status.message,
					error: status.error,
				};
				if (status.workingCount !== undefined || status.episodicCount !== undefined) {
					report.entryCount = (status.workingCount ?? 0) + (status.episodicCount ?? 0);
				}
			} catch (error) {
				warn("status", error);
			}
		}
		if (backend.stats) {
			try {
				report.stats = await backend.stats(agentDir, cwd, session);
			} catch (error) {
				warn("stats", error);
			}
		}
		if (backend.diagnose) {
			try {
				report.diagnosis = await backend.diagnose(agentDir, cwd, session);
			} catch (error) {
				warn("diagnose", error);
			}
		}
		return report;
	},

	/** Built-in theme names plus `<agentDir>/themes/*.json`, sorted by name. */
	get_themes: async () => ({ themes: await getAvailableThemesWithPaths() }),

	/** Resolved CSS colors (variable refs and ANSI-256 indices resolved) keyed by theme token. */
	get_theme_colors: async params => {
		const name = requireString(paramsOf(params), "name");
		return { name, colors: await getResolvedThemeColors(name) };
	},
};
