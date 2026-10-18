/**
 * gui-bridge pstack engineering mode (modes/pstack-core.ts): which sessions get the always-on `<pstack>` section.
 * The rules are a table; `install` is exercised on a fake `pi` so the hook, the session reads and the env gate are
 * the real code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTOPILOT_STATE_ENTRY } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	install,
	PSTACK_ENV,
	type PstackGate,
	type PstackHost,
	pstackText,
	pstackVariant,
} from "../../resources/gui-bridge/modes/pstack-core";
import {
	PSTACK_AUTOPILOT_SECTION,
	PSTACK_SECTION,
	PSTACK_SECTION_SOLO,
} from "../../resources/gui-bridge/modes/pstack-text";
import type { JournalEntry, PromptSectionContext } from "../../resources/gui-bridge/prompt-sections";

const ON: PstackGate = { enabled: true, kind: "main", planMode: false, autopilot: false, solo: false };

describe("pstackVariant", () => {
	it.each([
		["a main agent with delegation", ON, "full"],
		["a main agent without the task tool (Solo)", { ...ON, solo: true }, "solo"],
		["Autopilot (the condensed section)", { ...ON, autopilot: true }, "autopilot"],
		["Autopilot with delegation off", { ...ON, autopilot: true, solo: true }, "autopilot"],
		["Plan mode", { ...ON, planMode: true }, undefined],
		["Plan mode without delegation", { ...ON, planMode: true, solo: true }, undefined],
		["a subagent", { ...ON, kind: "sub" }, undefined],
		["a subagent of an Autopilot run", { ...ON, kind: "sub", autopilot: true }, undefined],
		["the switch off", { ...ON, enabled: false }, undefined],
		["the switch off in Autopilot", { ...ON, enabled: false, autopilot: true }, undefined],
	] as const)("%s", (_name, gate, expected) => {
		expect(pstackVariant(gate)).toBe(expected);
	});
});

describe("pstackText", () => {
	it("is static: the same bytes on every call (the provider's prompt cache holds)", () => {
		expect(pstackText("full")).toBe(PSTACK_SECTION);
		expect(pstackText("full")).toBe(pstackText("full"));
		expect(pstackText("solo")).toBe(PSTACK_SECTION_SOLO);
		expect(pstackText("autopilot")).toBe(PSTACK_AUTOPILOT_SECTION);
		expect(pstackText(undefined)).toBeUndefined();
	});

	it("flips only the delegation paragraph when delegation is off", () => {
		expect(PSTACK_SECTION).toContain('agent: "pstack-agent"');
		expect(PSTACK_SECTION_SOLO).not.toContain("ompdesk_session_open` with `worktree: true`. Never delegate");
		expect(PSTACK_SECTION_SOLO).toContain("there is no `task` tool");
		const head = (text: string) => text.slice(0, text.indexOf("## Delegation"));
		const tail = (text: string) => text.slice(text.indexOf("## Writing the reply"));
		expect(head(PSTACK_SECTION_SOLO)).toBe(head(PSTACK_SECTION));
		expect(tail(PSTACK_SECTION_SOLO)).toBe(tail(PSTACK_SECTION));
	});

	it("keeps the routing gate and the precedence line in the full section", () => {
		expect(PSTACK_SECTION).toContain("## Routing gate");
		expect(PSTACK_SECTION).toContain("A trivial request gets a plain answer");
		expect(PSTACK_SECTION).toMatch(
			/repository's rules files[\s\S]*then what the user asks for[\s\S]*then a skill the user invoked/,
		);
	});

	it("keeps the Autopilot variant away from shipping playbooks", () => {
		expect(PSTACK_AUTOPILOT_SECTION).toContain("HARD LIMITS outrank");
		expect(PSTACK_AUTOPILOT_SECTION).toContain("skill://poteto-mode/playbooks/bug-fix.md");
		expect(PSTACK_AUTOPILOT_SECTION).toContain("Do not use babysit, shipping");
	});
});

function context(kind: string, entries: JournalEntry[] = []): PromptSectionContext {
	return { sessionManager: { getBranch: () => entries }, agent: { kind } };
}

interface FakeSession {
	planMode: boolean;
	tools: string[];
}

function fakeHost(session: FakeSession | undefined): {
	host: PstackHost;
	run: (ctx: PromptSectionContext) => string[];
} {
	let handler:
		| ((event: { systemPrompt: string[] }, ctx: PromptSectionContext) => { systemPrompt: string[] } | undefined)
		| undefined;
	const host: PstackHost = {
		on: (_event, fn) => {
			handler = fn;
		},
		pi: {
			MAIN_AGENT_ID: "main",
			AgentRegistry: {
				global: () => ({
					get: () =>
						session
							? {
									session: {
										getPlanModeState: () => ({ enabled: session.planMode }),
										getActiveToolNames: () => session.tools,
									},
								}
							: undefined,
				}),
			},
		},
	};
	install(host);
	return { host, run: ctx => handler?.({ systemPrompt: ["base"] }, ctx)?.systemPrompt ?? ["base"] };
}

describe("install", () => {
	const saved = process.env[PSTACK_ENV];
	beforeEach(() => {
		process.env[PSTACK_ENV] = "1";
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[PSTACK_ENV];
		else process.env[PSTACK_ENV] = saved;
	});

	const tools = ["read", "task", "todo"];

	it("appends the full section to a Code session's main agent, once", () => {
		const { run } = fakeHost({ planMode: false, tools });
		expect(run(context("main"))).toEqual(["base", PSTACK_SECTION]);
	});

	it("gives the Solo variant when the task tool is absent", () => {
		const { run } = fakeHost({ planMode: false, tools: ["read", "todo"] });
		expect(run(context("main"))).toEqual(["base", PSTACK_SECTION_SOLO]);
	});

	it("leaves Plan mode, a subagent and a switched-off session alone", () => {
		expect(fakeHost({ planMode: true, tools }).run(context("main"))).toEqual(["base"]);
		expect(fakeHost({ planMode: false, tools }).run(context("sub"))).toEqual(["base"]);
		process.env[PSTACK_ENV] = "0";
		expect(fakeHost({ planMode: false, tools }).run(context("main"))).toEqual(["base"]);
		delete process.env[PSTACK_ENV];
		expect(fakeHost({ planMode: false, tools }).run(context("main"))).toEqual(["base"]);
	});

	it("swaps in the condensed section while an Autopilot run is running or stopping, not after it ended", () => {
		const { run } = fakeHost({ planMode: false, tools });
		const state = (value: string): JournalEntry => ({
			type: "custom",
			customType: AUTOPILOT_STATE_ENTRY,
			data: { state: value },
		});
		expect(run(context("main", [state("running")]))).toEqual(["base", PSTACK_AUTOPILOT_SECTION]);
		expect(run(context("main", [state("running"), state("stopping")]))).toEqual(["base", PSTACK_AUTOPILOT_SECTION]);
		expect(run(context("main", [state("running"), state("ended")]))).toEqual(["base", PSTACK_SECTION]);
	});

	it("does not duplicate a section a prompt already carries", () => {
		const { host } = fakeHost({ planMode: false, tools });
		expect(host).toBeDefined();
		const { run } = fakeHost({ planMode: false, tools });
		const once = run(context("main"));
		expect(once.filter(part => part === PSTACK_SECTION)).toHaveLength(1);
	});

	it("still works before the main session is registered", () => {
		expect(fakeHost(undefined).run(context("main"))).toEqual(["base", PSTACK_SECTION]);
	});
});
