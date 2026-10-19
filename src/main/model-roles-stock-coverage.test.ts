import { existsSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HIDDEN_ROLES } from "../../resources/gui-bridge/model-role-contracts";
import { I18nProvider, setLanguageOverride } from "../renderer/lib/i18n";
import { en } from "../renderer/locales/en";
import { ko } from "../renderer/locales/ko";
import { useSessionStore } from "../renderer/stores/session";
import type { ModelRoleEntry } from "../shared/rpc-types";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * A role the installed omp has must reach Settings › Model roles with words, whatever OMPdesk's code knows:
 *
 * - every stock `MODEL_ROLE_IDS` id is in the bridge's `model_roles` answer with stock's metadata (`accepts`,
 *   `defaults`), and is shown unless stock or OMPdesk hides it (`HIDDEN_ROLES` names why);
 * - every shown row, rendered from those very rows in English and Korean, says when the role is used and, while
 *   it is empty, what it falls back to, and no raw locale key reaches the DOM;
 * - two roles no OMPdesk table knows (a chat one and a model-kind one) get the same through the generic path.
 */

const PROBE = `
import { methods } from "./settings";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   // The candidate pools (the whole catalog for some roles) would pass stderr's 64 KB pipe write; the words need none.
   const roles = (await methods.model_roles({}, env)).roles.map(role => ({ ...role, candidates: [] }));
   console.error("COVERAGE_PROBE=" + JSON.stringify({ ids: MODEL_ROLE_IDS, roles }));
   process.exit(0);
  } catch (error) {
   console.error("COVERAGE_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	requestAnimationFrame: (callback: () => void) => {
		callback();
		return 0;
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist (a static import would run first): react-dom reads `window`/`document`
// at import time.
const { createRoot } = await import("react-dom/client");
const { ModelRolesSection } = await import("../renderer/components/settings/ModelRolesSection");

/** The test's stand-in for the preload's `window.omp`. */
const host = window as unknown as { omp?: unknown };

/** Roles a newer omp could add: one table in OMPdesk knows them. */
const SYNTHETIC: ModelRoleEntry[] = [
	{
		id: "future-chat",
		name: "Future chat",
		tag: "FUTURE",
		section: "chat",
		source: "default",
		accepts: ["chat"],
		defaults: [],
		candidates: [{ provider: "openai", id: "gpt", name: "GPT", kind: "chat" }],
		effective: { model: "openai/gpt", name: "GPT", source: "fallback", via: "smol" },
	},
	{
		id: "future-kind",
		name: "Future kind",
		tag: "FUTUREKIND",
		section: "kind",
		source: "default",
		accepts: ["video"],
		defaults: ["acme/vid-1"],
		candidates: [],
		effective: { source: "none" },
	},
];

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	setLanguageOverride(null);
	host.omp = undefined;
	useSessionStore.getState().reset();
});

async function render(roles: ModelRoleEntry[], lang: "en" | "ko"): Promise<void> {
	const ok = (data: unknown) => ({ success: true, data });
	host.omp = {
		rpc: {
			getModelRoles: async () => ok({ roles }),
			setModelRole: async () => ({ success: true }),
			getUsage: async () => ok({ reports: [], session: {} }),
		},
		events: { onConfigUpdate: () => () => {} },
	};
	setLanguageOverride(lang);
	useSessionStore.getState().setStatus("ready", "/repo");
	root = createRoot(document.body as unknown as Element);
	await act(async () => root?.render(createElement(I18nProvider, null, createElement(ModelRolesSection))));
	await act(async () => {});
}

/** The row's description: inline when short, else the info tooltip's text (kept in the DOM for screen readers). */
function described(id: string): string {
	const row = document.body.querySelector(`#model-role-${id}`);
	return [...(row?.querySelectorAll("[data-setting-desc], .sr-only") ?? [])]
		.map(element => element.textContent ?? "")
		.join(" ");
}

const EMPTY = { en: "Empty:", ko: "비어 있으면" } as const;

describe.skipIf(!existsSync(INSTALLED_OMP))("every stock model role reaches Settings with words", () => {
	// A hook, not the describe body: vitest runs a skipped suite's body to collect it, never its hooks.
	let probe: { ids: string[]; roles: ModelRoleEntry[] } = { ids: [], roles: [] };
	beforeAll(() => {
		probe = runBridgeProbe(PROBE, "COVERAGE_PROBE") as typeof probe;
	}, 130_000);
	const shown = (roles: ModelRoleEntry[]) => roles.filter(role => !role.hidden && !(role.id in HIDDEN_ROLES));

	it("lists each installed role with stock's metadata, or hides it with a reason", () => {
		for (const id of probe.ids) {
			const role = probe.roles.find(entry => entry.id === id);
			expect(role, `${id} missing from model_roles`).toBeDefined();
			expect(role?.accepts?.length, `${id} accepts`).toBeGreaterThan(0);
			expect(Array.isArray(role?.defaults), `${id} defaults`).toBe(true);
			if (id in HIDDEN_ROLES) expect(HIDDEN_ROLES[id]?.length, `${id} hidden without a reason`).toBeGreaterThan(20);
		}
		expect(shown(probe.roles).length).toBeGreaterThan(0);
	});

	for (const lang of ["en", "ko"] as const) {
		it(`says when each role is used and what an empty one follows, in ${lang}, for stock's roles and unknown ones`, async () => {
			const roles = [...probe.roles, ...SYNTHETIC];
			await render(roles, lang);
			const messages = (lang === "en" ? en : ko) as Record<string, string>;
			for (const role of shown(roles)) {
				const text = described(role.id);
				const own = messages[`modelRoles.use.${role.id}`];
				if (own) expect(text, `${lang} ${role.id}`).toContain(own);
				else expect(text, `${lang} ${role.id} purpose`).toContain(role.name);
				if (role.model === undefined) expect(text, `${lang} ${role.id} fallback`).toContain(EMPTY[lang]);
			}
			expect(document.body.textContent ?? "").not.toMatch(/modelRoles\.[a-zA-Z]/);
			const listed = [...document.body.querySelectorAll("[data-setting-row]")].map(row => row.id);
			expect(listed).toEqual(expect.arrayContaining(shown(roles).map(role => `model-role-${role.id}`)));
		}, 20_000);
	}
});
