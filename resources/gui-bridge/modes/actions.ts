/**
 * One-shot mode actions stock wires only to its terminal UI: `/tan` (background
 * tangent agent), `/omfg` (forge a TTSR rule from a complaint) and the global
 * agent pause gate (the TUI's pause toggle).
 */
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeEnv, BridgeMethods } from "../types";
import { attach, ompPrompt, record } from "./shared";

const TAN_DISPATCHED = "Dispatched background tan ";

/** Run stock's `/tan` engine with the slice of the TUI context it reads; its status line carries the job id. */
async function startTan(session: AgentSession, work: string): Promise<{ jobId: string }> {
	const { TanCommandController } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller");
	const { MCPManager } = await import("@oh-my-pi/pi-coding-agent/mcp/manager");
	let status = "Unable to dispatch background tan.";
	const context = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		mcpManager: MCPManager.instance(),
		showStatus: (message: string) => {
			status = message;
		},
		showError: (message: string) => {
			status = message;
		},
		// The GUI re-reads the transcript itself; no terminal chat to rebuild here.
		rebuildChatFromMessages: () => {},
	};
	await new TanCommandController(context as never).start(work);
	if (!status.startsWith(TAN_DISPATCHED)) throw new Error(status);
	return { jobId: status.slice(TAN_DISPATCHED.length).trim() };
}

const MAX_OMFG_ATTEMPTS = 3;
const PROJECT_OPTION = "This project (.omp/rules)";
const GLOBAL_OPTION = "Global — all projects (~/.omp/agent/rules)";
const AMEND_OPTION = "Amend with feedback…";

interface OmfgCandidate {
	rule: { name: string; question?: unknown };
	fileContent: string;
	validated: boolean;
}

/**
 * Stock `OmfgController` without its TUI panel: generate a rule with an ephemeral
 * turn (up to three attempts, validated against this conversation), then ask
 * where to save it through the RPC UI dialogs (`ctx.ui`), as the TUI does.
 */
async function runOmfg(
	session: AgentSession,
	env: BridgeEnv,
	complaint: string,
): Promise<{ state: "saved" | "rejected" | "aborted"; savedPath?: string }> {
	const trimmed = complaint.trim();
	if (!trimmed) throw new Error("Usage: /omfg <complaint>");
	if (!session.model) throw new Error("No active model available for /omfg.");
	const ui = env.context().ui;
	const { prompt, CONFIG_DIR_NAME } = await import("@oh-my-pi/pi-utils");
	const rules = await import("@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule");
	const { TtsrToolInspector } = await import("@oh-my-pi/pi-coding-agent/session/ttsr-outputs");
	const { invalidate } = await import("@oh-my-pi/pi-coding-agent/capability");
	const template = ompPrompt("system/omfg-user.md");
	const inspector = new TtsrToolInspector(
		() => session.agent.state.tools,
		() => session.sessionManager.getCwd(),
	);

	const generate = async (initialFeedback?: string, startRule?: string): Promise<OmfgCandidate | undefined> => {
		const failed = initialFeedback ? [initialFeedback] : [];
		let previousRule = startRule;
		let last: Omit<OmfgCandidate, "validated"> | undefined;
		for (let attempt = 1; attempt <= MAX_OMFG_ATTEMPTS; attempt++) {
			const { replyText } = await session.runEphemeralTurn({
				promptText: prompt.render(template, {
					complaint: trimmed,
					feedback: failed.length > 0 ? failed.join("\n\n") : undefined,
					previousRule,
				}),
				dedupeReply: false,
			});
			const parsed = rules.parseGeneratedRule(replyText);
			if ("error" in parsed) {
				const failedRule = rules.extractGeneratedRuleJson(replyText) ?? replyText.trim();
				failed.push(`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failedRule}`);
				previousRule = failedRule;
				continue;
			}
			const validated = await rules.validateParsedRuleAgainstAssistantHistory(
				parsed,
				rules.historyOutputs(session.messages, inspector),
				parsed.rule.question !== undefined ? session.ruleJudge() : undefined,
			);
			if (validated.validation.matched) return { ...validated.candidate, validated: true };
			// Regenerating cannot conjure a judge; let the user decide on this candidate.
			if (validated.validation.judgeUnavailable) return { ...validated.candidate, validated: false };
			last = validated.candidate;
			const reason = validated.validation.feedback ?? "The rule condition did not match any earlier assistant output.";
			failed.push(
				`Attempt ${attempt} failed validation:\n${reason}\nFailed candidate:\n${validated.candidate.fileContent}`,
			);
			previousRule = validated.candidate.fileContent;
		}
		return last ? { ...last, validated: false } : undefined;
	};

	let candidate = await generate();
	for (;;) {
		if (!candidate) throw new Error("The model did not return a valid TTSR rule.");
		if (!candidate.validated) {
			const save = await ui.confirm("Validation", "Couldn't confirm this rule matches the conversation. Save anyway?");
			if (!save) return { state: "rejected" };
		}
		const location = await ui.select("Save TTSR rule where?", [PROJECT_OPTION, GLOBAL_OPTION, AMEND_OPTION]);
		if (!location) return { state: "aborted" };
		if (location === AMEND_OPTION) {
			const amendment = (
				await ui.input("Amend TTSR rule", "e.g. Make it specific to Ruby string eval in tool:write(*.rb)")
			)?.trim();
			if (!amendment) continue;
			candidate = await generate(
				`User requested this amendment before saving:\n${amendment}`,
				candidate.fileContent,
			);
			continue;
		}
		const global = location === GLOBAL_OPTION;
		const filePath = global
			? path.join(session.settings.getAgentDir(), "rules", `${candidate.rule.name}.md`)
			: path.join(session.sessionManager.getCwd(), CONFIG_DIR_NAME, "rules", `${candidate.rule.name}.md`);
		if (await Bun.file(filePath).exists()) {
			const overwrite = await ui.confirm("Overwrite TTSR rule?", `${filePath} already exists. Overwrite it?`);
			if (!overwrite) return { state: "rejected" };
		}
		await Bun.write(filePath, candidate.fileContent);
		// Drop the cached directory listings so the next rule rediscovery sees the new file.
		invalidate(filePath);
		invalidate(path.dirname(filePath));
		session.ttsrManager?.addRule(
			rules.buildOmfgRuleForPath(candidate.rule.name, candidate.fileContent, filePath, global ? "user" : "project"),
		);
		return { state: "saved", savedPath: filePath };
	}
}

export const methods: BridgeMethods = {
	...guard("tan", {
		"modes.tan": async (params, env) => {
			const { work } = record(params);
			const trimmed = typeof work === "string" ? work.trim() : "";
			if (!trimmed) throw new Error("Usage: /tan <work>");
			return startTan(attach(env), trimmed);
		},
	}),
	...guard("omfg", {
		"modes.omfg": async (params, env) => {
			const { complaint } = record(params);
			return runOmfg(attach(env), env, typeof complaint === "string" ? complaint : "");
		},
	}),
	...guard("agentPause", {
		"modes.set_agents_paused": async (params, _env) => {
			const { agentPauseGate } = await import("@oh-my-pi/pi-agent-core");
			if (record(params).enabled === true) {
				agentPauseGate.pause();
				return { paused: true, pausedAt: agentPauseGate.pausedAt };
			}
			return { paused: false, heldMs: agentPauseGate.resume() };
		},
	}),
};
