/**
 * pstack's always-on prompt section, pure half: which text (if any) a session gets. The wiring is in
 * ./pstack.ts, the static texts in ./pstack-text.ts (generated from the built-in pack), the pack itself is
 * `resources/omp-builtin/pstack/`.
 *
 * Off (no text) for: the switch off or a project-less chat session (main sets `OMP_GUI_PSTACK=0`), every subagent
 * (they get the `pstack-agent` wrapper), and Plan mode (read-only planning). Autopilot sessions get the condensed
 * section instead: its protocol and HARD LIMITS outrank the playbooks. A session without the `task` tool (Solo
 * delegation) gets the variant whose delegation paragraph says to do the work itself.
 *
 * No omp imports (not even types): the GUI's vitest loads this file directly.
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import { lastStateEntry } from "./autopilot-core";
import { PSTACK_AUTOPILOT_SECTION, PSTACK_SECTION, PSTACK_SECTION_SOLO } from "./pstack-text";

/** Env `OMP_GUI_PSTACK` main sets at spawn: `1` on, anything else off. */
export const PSTACK_ENV = "OMP_GUI_PSTACK";

export interface PstackGate {
	/** `OMP_GUI_PSTACK === "1"`. */
	enabled: boolean;
	/** `ctx.agent.kind`: `main` or a subagent. */
	kind: string;
	planMode: boolean;
	/** The branch journals a running or stopping Autopilot run (parent or child). */
	autopilot: boolean;
	/** The `task` tool is not available to this session. */
	solo: boolean;
}

export type PstackVariant = "full" | "solo" | "autopilot";

/** Which text this session gets; undefined for none. */
export function pstackVariant(gate: PstackGate): PstackVariant | undefined {
	if (!gate.enabled || gate.kind !== "main") return undefined;
	if (gate.autopilot) return "autopilot";
	if (gate.planMode) return undefined;
	return gate.solo ? "solo" : "full";
}

const TEXTS: Readonly<Record<PstackVariant, string>> = {
	full: PSTACK_SECTION,
	solo: PSTACK_SECTION_SOLO,
	autopilot: PSTACK_AUTOPILOT_SECTION,
};

/** The section text for `variant`, byte-identical on every call (the provider's prompt cache holds). */
export function pstackText(variant: PstackVariant | undefined): string | undefined {
	return variant ? TEXTS[variant] : undefined;
}

/** True while the journal's last Autopilot state entry is running or stopping. */
export function autopilotRunning(entries: Parameters<typeof lastStateEntry>[0]): boolean {
	const state = lastStateEntry(entries)?.state;
	return state === "running" || state === "stopping";
}

/** The slice of the main session the gate reads. */
interface PstackSession {
	getPlanModeState(): { enabled?: boolean } | undefined;
	getActiveToolNames(): readonly string[];
}

/** The slice of omp's ExtensionAPI the section registers on and reads the main session through. */
export interface PstackHost extends PromptSectionHost {
	pi: {
		AgentRegistry: { global(): { get(id: unknown): { session?: PstackSession } | undefined } };
		MAIN_AGENT_ID: unknown;
	};
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: PstackHost): void {
	registerPromptSection(pi, "pstack", ctx => {
		if (process.env[PSTACK_ENV] !== "1" || ctx.agent.kind !== "main") return undefined;
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
		return pstackText(
			pstackVariant({
				enabled: true,
				kind: ctx.agent.kind,
				planMode: Boolean(session?.getPlanModeState()?.enabled),
				autopilot: autopilotRunning(ctx.sessionManager.getBranch()),
				solo: session ? !session.getActiveToolNames().includes("task") : false,
			}),
		);
	});
}
