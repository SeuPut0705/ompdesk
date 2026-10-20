/**
 * Agent definitions, subagent revive and transcripts,
 * and TUI themes. Ported from the omp-gui fork's rpc-agents / rpc-domains /
 * rpc-mode theme cases onto stock omp internals.
 */
import path from "node:path";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { type ParsedAgentFields, parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BlobStore, parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { AgentParsingError } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { getResolvedThemeColors } from "@oh-my-pi/pi-tui/theme";
import { getBlobsDir, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { paramsOf, requireString } from "./shared";

/** Where omp's discovery reads `.omp` task agents for this session: the user dir and the nearest project dir (or where it would be). */
async function agentDirs(session: AgentSession): Promise<{ user: string; project: string }> {
	// Dynamic: `config` is a source copy whose first import transpiles omp's source tree (~540 ms of omp's only thread), so it loads on use, not at startup.
	const { findAllNearestProjectConfigDirs, getConfigDirs } = await import("@oh-my-pi/pi-coding-agent/config");
	const cwd = path.resolve(session.sessionManager.getCwd());
	const user = getConfigDirs("agents", { project: false }).find(entry => entry.source === ".omp")?.path;
	if (!user) throw new Error("omp reports no user agents directory");
	const nearest = findAllNearestProjectConfigDirs("agents", cwd).find(entry => entry.source === ".omp")?.path;
	return { user: path.resolve(user), project: path.resolve(nearest ?? path.join(cwd, ".omp", "agents")) };
}

async function discover(session: AgentSession) {
	const { agents } = await discoverAgents(session.sessionManager.getCwd(), undefined, session.effectiveExtensionRoots);
	return agents;
}

export const methods: BridgeMethods = {
	...guard("agents", {
		/** Same field/YAML parser as stock task agents; never writes a file. */
		validate_agent_definition: async params => {
			const p = paramsOf(params);
			const content = requireString(p, "content");
			const source = typeof p.source === "string" ? p.source : "agent-definition.md";
			const { frontmatter, body } = parseFrontmatter(content, { location: source, level: "fatal" });
			const fields = parseAgentFields(frontmatter);
			if (!fields) {
				throw new AgentParsingError(new Error(`Invalid agent field: ${source}\n${content}`), source);
			}
			return { fields, body };
		},
		/** Workspace-visible definitions plus the TUI control center's model/prewalk projection. */
		get_agent_definitions: async (_params, env) => {
			const session = env.session();
			const hub = createAgentsHubDeps(
				session.sessionManager.getCwd(),
				session.settings,
				session.modelRegistry,
				() => session.effectiveExtensionRoots,
				session.model ? formatModelString(session.model) : undefined,
				session.settings.getModelRole("default"),
			);
			const agents = await hub.loadAgents();
			const dirs = await agentDirs(session);
			const scopeOf = (filePath: string | undefined) => {
				if (!filePath) return undefined;
				const parent = path.dirname(path.resolve(filePath));
				return parent === dirs.project ? "project" : parent === dirs.user ? "user" : undefined;
			};
			return {
				agents: agents.map(hubAgent => {
					// loadAgents spreads the definition; HubAgent's public type
					// omits authoring fields that remain present at runtime.
					const agent = hubAgent as typeof hubAgent & ParsedAgentFields;
					const defaultPatterns = hub.effectiveModelPatterns({ ...agent, overrideModel: undefined });
					const effectivePatterns = hub.effectiveModelPatterns(agent);
					const effective = hub.resolvePatterns(effectivePatterns);
					const prewalkPattern = hub.effectivePrewalkPattern(agent);
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
						advisor: agent.advisor,
						disabled: agent.disabled,
						overrideModel: agent.overrideModel,
						prewalkOverride: agent.prewalkOverride,
						advisorOverride: agent.advisorOverride,
						advisorPattern: hub.effectiveAdvisorPattern(agent),
						scope: agent.source === "bundled" ? undefined : scopeOf(agent.filePath),
						defaultPatterns,
						defaultResolved: hub.resolvePatterns(defaultPatterns),
						effectivePatterns,
						effectiveResolved: effective,
						prewalkPattern,
						prewalkResolved: prewalkPattern ? hub.resolvePatterns([prewalkPattern]) : undefined,
					};
				}),
			};
		},

		/** One discovered definition with its system prompt (the editor's Duplicate of bundled/extension agents). */
		get_agent_definition: async (params, env) => {
			const name = requireString(paramsOf(params), "name");
			const agent = (await discover(env.session())).find(entry => entry.name === name);
			if (!agent) throw new Error(`Unknown agent "${name}"`);
			return {
				name: agent.name,
				description: agent.description,
				source: agent.source,
				filePath: agent.filePath,
				systemPrompt: agent.systemPrompt,
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				tools: agent.tools,
				spawns: agent.spawns,
				autoloadSkills: agent.autoloadSkills,
				output: agent.output,
				blocking: agent.blocking,
				readSummarize: agent.readSummarize,
				prewalk: agent.prewalk,
				advisor: agent.advisor,
			};
		},

		/** Agent directories discovery reads, plus omp's tool names for the editor's tool picker. */
		get_agent_authoring: async (_params, env) => {
			const session = env.session();
			const hidden = new Set<string>(HIDDEN_TOOL_NAMES);
			const registered = typeof session.getAllToolNames === "function" ? session.getAllToolNames() : [];
			return {
				dirs: await agentDirs(session),
				builtinTools: [...BUILTIN_TOOL_NAMES],
				registeredTools: registered.filter(name => !hidden.has(name)),
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

		/**
		 * A settled subagent's transcript after a relaunch. Stock's RPC registry learns
		 * session files only from live lifecycle frames, while the executor writes every
		 * child to `<artifactsDir>/<id>.jsonl`; stock's own reader parses it.
		 */
		get_subagent_transcript: async (params, env) => {
			const p = paramsOf(params);
			const subagentId = requireString(p, "subagentId");
			if (subagentId !== path.basename(subagentId) || subagentId.startsWith("."))
				throw new Error("Invalid subagent id");
			const artifactsDir = env.session().sessionManager.getArtifactsDir();
			if (!artifactsDir) throw new Error("Session is not persisted");
			const sessionFile = path.join(artifactsDir, `${subagentId}.jsonl`);
			if (!(await Bun.file(sessionFile).exists()))
				throw new Error(`Unknown subagent or session file unavailable: ${subagentId}`);
			return readRpcSubagentTranscript(sessionFile, typeof p.fromByte === "number" ? p.fromByte : 0);
		},

		/**
		 * The bytes behind one persisted image reference (`blob:sha256:<hex>`), base64, or
		 * `null` once the blob is gone. Stock externalizes image data to its blob store and
		 * resolves it only when it loads a session itself; transcripts parsed straight from a
		 * JSONL (subagents) keep the reference. The store is the one stock's session manager uses.
		 */
		read_image_blob: async params => {
			const hash = parseBlobRef(requireString(paramsOf(params), "ref"));
			if (!hash) throw new Error("Invalid image blob reference");
			const bytes = await new BlobStore(getBlobsDir()).get(hash);
			return { data: bytes ? bytes.toString("base64") : null };
		},
	}),

	...guard("themes", {
		/** Resolved CSS colors (variable refs and ANSI-256 indices resolved) keyed by theme token. */
		get_theme_colors: async params => {
			const name = requireString(paramsOf(params), "name");
			return { name, colors: await getResolvedThemeColors(name) };
		},
	}),
};
