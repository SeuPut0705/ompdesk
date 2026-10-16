/**
 * Context inspector (Insights › This session): what the live session's
 * context holds, entry by entry. Stock's `/context` (`getContextBreakdown`)
 * gives five category totals only; this lists every tool, skill, context
 * file, system prompt block and message the provider gets, each counted with
 * the session's own tokenizer through stock's estimators
 * (`pi-tui/status-line/context-usage.ts` `estimateToolSchemaTokens` /
 * `estimateSkillsTokens`, `Tokenizer.countMessage`), and splits the tools by
 * source (built-in, MCP, extension) the way `composer.tool_extras` does.
 * Category totals stay stock's provider-anchored figures; per-entry counts
 * are estimates. Rules in context-inspect-core.ts.
 */

import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { estimateSkillsTokens, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import {
	type ContextCategory,
	capPreview,
	llmMessagesText,
	type Preview,
	promptSkills,
	repoRulesFiles,
	snippet,
	TOOL_CATEGORY,
	type ToolSource,
} from "./context-inspect-core";
import { guard } from "./health";
import { withTurnSections } from "./prompt-sections";
import type { BridgeMethods } from "./types";

interface Entry {
	/** Stable within one read: `prompt:<i>`, `file:<path>`, `tool:<name>`, `deferred:<name>`, `skill:<name>`, `msg:<i>:<timestamp>`. */
	id: string;
	category: ContextCategory;
	label: string;
	/** Message role for `msg:` entries. */
	role?: string;
	tokens: number;
	/** An xd:// mounted tool: listed in the prompt by name only, its schema loads on use. */
	deferred?: true;
}

function toolSource(session: AgentSession, name: string): ToolSource {
	return name.startsWith("mcp__") ? "mcp" : session.hasBuiltInTool(name) ? "builtin" : "extension";
}

function messageTimestamp(message: object): number {
	return "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
}

/**
 * The system prompt of the next turn. Stock keeps only what it built in
 * `session.systemPrompt` between turns; OMPdesk's own sections (reply language,
 * profile, reply style, visuals) join through `before_agent_start`
 * as a turn starts, so they are applied here the way the hook does.
 */
function turnPrompt(session: AgentSession): { parts: readonly string[]; added: readonly string[] } {
	const stock = session.systemPrompt;
	const parts = withTurnSections(stock, { sessionManager: session.sessionManager, agent: { kind: "main" } });
	return { parts, added: parts.slice(stock.length) };
}

/** `withEntries` false: the category totals only (Insights' breakdown card), without walking the messages. */
function inspect(session: AgentSession, withEntries: boolean) {
	const tokenizer = session.agent.tokenizer;
	const breakdown = session.getContextBreakdown();
	const tools = session.agent.state.tools;
	const entries: Entry[] = [];
	const totals: Record<ContextCategory, number> = {
		systemPrompt: breakdown?.systemPromptTokens ?? 0,
		systemContext: 0,
		memoryFiles: 0,
		builtinTools: 0,
		mcpTools: 0,
		extensionTools: 0,
		skills: breakdown?.skillsTokens ?? 0,
		messages: breakdown?.messagesTokens ?? 0,
	};

	const { parts, added } = turnPrompt(session);
	if (parts[0])
		entries.push({ id: "prompt:0", category: "systemPrompt", label: snippet(parts[0]), tokens: totals.systemPrompt });
	let filesTokens = 0;
	for (let index = 1; index < parts.length; index++) {
		const part = parts[index] ?? "";
		let rest = tokenizer.countTokens(part);
		for (const file of repoRulesFiles(part)) {
			const tokens = tokenizer.countTokens(file.block);
			rest -= tokens;
			filesTokens += tokens;
			entries.push({ id: `file:${file.path}`, category: "memoryFiles", label: file.path, tokens });
		}
		entries.push({
			id: `prompt:${index}`,
			category: "systemContext",
			label: snippet(part),
			tokens: Math.max(0, rest),
		});
	}
	// Stock's systemContext covers every stock block after the first; the files are part of it. OMPdesk's own sections are not in stock's figure.
	const systemContext =
		(breakdown?.systemContextTokens ?? 0) + added.reduce((sum, part) => sum + tokenizer.countTokens(part), 0);
	totals.memoryFiles = Math.min(filesTokens, systemContext);
	totals.systemContext = systemContext - totals.memoryFiles;

	// A one-tool roster is summed by the same estimator stock uses for the whole set.
	const revision = session.settings.revision;
	for (const tool of tools) {
		const category = TOOL_CATEGORY[toolSource(session, tool.name)];
		const tokens = estimateToolSchemaTokens([tool], tokenizer, revision);
		totals[category] += tokens;
		entries.push({ id: `tool:${tool.name}`, category, label: tool.name, tokens });
	}
	for (const mounted of session.getXdevToolEntries()) {
		entries.push({
			id: `deferred:${mounted.name}`,
			category: TOOL_CATEGORY[toolSource(session, mounted.name)],
			label: mounted.name,
			tokens: 0,
			deferred: true,
		});
	}

	if (totals.skills > 0) {
		const names = tools.map(tool => tool.name);
		for (const skill of promptSkills(session.renderedSkills, names)) {
			entries.push({
				id: `skill:${skill.name}`,
				category: "skills",
				label: skill.name,
				tokens: estimateSkillsTokens([skill], tokenizer),
			});
		}
	}

	if (withEntries) {
		session.agent.state.messages.forEach((message, index) => {
			entries.push({
				id: `msg:${index}:${messageTimestamp(message)}`,
				category: "messages",
				label: snippet(llmMessagesText(convertToLlm([message]))),
				role: message.role,
				tokens: tokenizer.countMessage(message),
			});
		});
	}

	return {
		model: session.model?.id ?? "",
		contextWindow: breakdown?.contextWindow ?? session.model?.contextWindow ?? 0,
		usedTokens: breakdown?.usedTokens ?? 0,
		anchored: breakdown?.anchored ?? false,
		categories: totals,
		entries: withEntries ? entries : [],
	};
}

function preview(session: AgentSession, id: string): Preview {
	const colon = id.indexOf(":");
	const kind = id.slice(0, colon);
	const key = id.slice(colon + 1);
	const parts = turnPrompt(session).parts;
	switch (kind) {
		case "prompt": {
			const part = parts[Number(key)];
			if (part !== undefined) return capPreview(part);
			break;
		}
		case "file": {
			for (const part of parts.slice(1)) {
				const file = repoRulesFiles(part).find(candidate => candidate.path === key);
				if (file) return capPreview(file.content);
			}
			break;
		}
		case "tool": {
			const tool = session.agent.state.tools.find(candidate => candidate.name === key);
			// The schema as stock serializes it for the provider (Ark/legacy schemas do not stringify as is).
			if (tool) return capPreview(`${tool.description ?? ""}\n\n${JSON.stringify(toolWireSchema(tool), null, 2)}`);
			break;
		}
		case "deferred": {
			const mounted = session.getXdevToolEntries().find(candidate => candidate.name === key);
			if (mounted) return capPreview(mounted.summary ?? "");
			break;
		}
		case "skill": {
			const skill = session.renderedSkills.find(candidate => candidate.name === key);
			if (skill) return capPreview(`${skill.name}: ${skill.description ?? ""}`);
			break;
		}
		case "msg": {
			const [index, timestamp] = key.split(":");
			const message = session.agent.state.messages[Number(index)];
			if (message && String(messageTimestamp(message)) === timestamp)
				return capPreview(llmMessagesText(convertToLlm([message])));
			break;
		}
	}
	throw new Error(`context_entry: ${id} is no longer in the context`);
}

export const methods: BridgeMethods = guard("contextInspector", {
	/** `{entries?: boolean}` (default true): every entry of the live context with its estimated tokens, plus stock's anchored totals. */
	"context.inspect": async (params, env) =>
		inspect(
			env.session(),
			!(typeof params === "object" && params !== null && "entries" in params && params.entries === false),
		),

	/** `{id}` from `context.inspect` → the entry's text as the provider gets it, capped at 32k characters. */
	"context.entry": async (params, env) => {
		const id = typeof params === "object" && params !== null && "id" in params ? params.id : undefined;
		if (typeof id !== "string" || !id.includes(":")) throw new Error("context.entry needs {id: string}");
		return preview(env.session(), id);
	},
});
