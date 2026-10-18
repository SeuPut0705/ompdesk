/**
 * Fake composer state for the toolbar prototypes (throwaway). No stores, no RPC: every variant reads one `Fake`
 * and calls `set`, so the real components (Button, IconButton, Popover, MenuButton, Tooltip) are exercised with
 * the real locale strings and tokens, and a click really changes what the toolbar shows.
 */

import { useState } from "react";

export type StateName = "idle" | "typing" | "running" | "running-draft" | "plan-goal";
export const STATE_NAMES: readonly StateName[] = ["idle", "typing", "running", "running-draft", "plan-goal"];

export type Thinking = "off" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly Thinking[] = ["off", "auto", "low", "medium", "high", "xhigh", "max"];
export type Approval = "yolo" | "write" | "always-ask";
export const APPROVALS: readonly Approval[] = ["yolo", "write", "always-ask"];
export type Delegation = "default" | "solo" | "assisted" | "collaborative" | "swarm";
export const DELEGATIONS: readonly Delegation[] = ["default", "solo", "assisted", "collaborative", "swarm"];
export type SendMode = "steer" | "followUp";

export interface Fake {
	draft: string;
	running: boolean;
	plan: boolean;
	goal: boolean;
	autopilot: boolean;
	autoMode: boolean;
	thinking: Thinking;
	/** What `auto` resolved to for the latest turn ("Auto · High"). */
	autoResolved: Thinking | null;
	approval: Approval;
	delegation: Delegation;
	fast: boolean;
	model: string;
	contextPercent: number;
	sendMode: SendMode;
	recording: boolean;
}

export interface FakeModel {
	id: string;
	name: string;
}

export const MODELS: readonly FakeModel[] = [
	{ id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
	{ id: "claude-opus-5", name: "Opus 5" },
	{ id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
	{ id: "gemini-3-pro", name: "Gemini 3 Pro" },
];
export const LONG_MODEL: FakeModel = {
	id: "anthropic/claude-sonnet-5-5-20260101-extended-context-preview",
	name: "Claude Sonnet 5.5 Extended Context (preview 2026-01-01)",
};

export const DRAFT_TEXT = "Move the thinking level into the model chip and keep Stop where it is";

export function fakeFor(state: StateName, longModel: boolean): Fake {
	const base: Fake = {
		draft: "",
		running: false,
		plan: false,
		goal: false,
		autopilot: false,
		autoMode: true,
		thinking: "auto",
		autoResolved: null,
		approval: "write",
		delegation: "default",
		fast: false,
		model: longModel ? LONG_MODEL.id : MODELS[0].id,
		contextPercent: 58,
		sendMode: "steer",
		recording: false,
	};
	switch (state) {
		case "typing":
			return { ...base, draft: DRAFT_TEXT };
		case "running":
			return { ...base, running: true, autoResolved: "high" };
		case "running-draft":
			return { ...base, running: true, draft: DRAFT_TEXT, autoResolved: "high" };
		case "plan-goal":
			return {
				...base,
				plan: true,
				goal: true,
				thinking: "high",
				approval: "yolo",
				delegation: "collaborative",
				fast: true,
				contextPercent: 86,
			};
		default:
			return base;
	}
}

export function modelOf(fake: Fake): FakeModel {
	if (fake.model === LONG_MODEL.id) return LONG_MODEL;
	return MODELS.find(model => model.id === fake.model) ?? MODELS[0];
}

export function useFake(initial: Fake): [Fake, (patch: Partial<Fake>) => void] {
	const [fake, setFake] = useState(initial);
	return [fake, patch => setFake(current => ({ ...current, ...patch }))];
}

export const activeModes = (fake: Fake): Array<"plan" | "goal" | "autopilot"> => {
	const modes: Array<"plan" | "goal" | "autopilot"> = [];
	if (fake.plan) modes.push("plan");
	if (fake.goal) modes.push("goal");
	if (fake.autopilot) modes.push("autopilot");
	return modes;
};

export interface ProtoProps {
	/** The composer's width in px: what the toolbar's own container sees (a split pane, a window). */
	width: number;
	initial: Fake;
}
