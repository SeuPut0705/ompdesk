import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALL_FEATURES,
	deriveUnavailable,
	FEATURES,
	hasPath,
	mergeAreaFailures,
	missingFor,
	type ProbeSources,
	parseHidden,
	REQUIREMENTS,
	requireFn,
	UnsupportedOmpError,
} from "../../resources/gui-bridge/capabilities";
import { en } from "../renderer/locales/en";

const BRIDGE_DIR = path.join(__dirname, "..", "..", "resources", "gui-bridge");

class FakeStore {
	static open() {}
	upsert() {}
}

/** A session with a method, a getter, an optional getter that is unset, and a nested manager. */
function fakeSession() {
	return {
		setPlanModeState() {},
		get asyncJobManager() {
			return undefined;
		},
		get explodes(): never {
			throw new Error("boom");
		},
		sessionManager: { getCwd: () => "/repo" },
	};
}

function sources(overrides: Partial<ProbeSources> = {}): ProbeSources {
	return {
		session: fakeSession(),
		pkg: { VERSION: "1.0.0" },
		modules: new Map<string, unknown>([["mod/btw", { BtwHistoryStore: FakeStore, getBtwTurns() {} }]]),
		hasPrompt: relative => relative === "present.md",
		...overrides,
	};
}

describe("hasPath", () => {
	it("requires a function for `()` paths and presence otherwise", () => {
		const session = fakeSession();
		expect(hasPath(session, "setPlanModeState()")).toBe(true);
		expect(hasPath(session, "sessionManager.getCwd()")).toBe(true);
		expect(hasPath(session, "sessionManager")).toBe(true);
		// An optional getter returning undefined still exists.
		expect(hasPath(session, "asyncJobManager")).toBe(true);
		expect(hasPath(session, "asyncJobManager.list()")).toBe(false);
		expect(hasPath(session, "sessionManager()")).toBe(false);
		expect(hasPath(session, "navigateTree()")).toBe(false);
		expect(hasPath(session, "explodes.anything")).toBe(false);
		expect(hasPath({ BtwHistoryStore: FakeStore }, "BtwHistoryStore.prototype.upsert()")).toBe(true);
		expect(hasPath({ BtwHistoryStore: FakeStore }, "BtwHistoryStore.prototype.retry()")).toBe(false);
		expect(hasPath(undefined, "x")).toBe(false);
	});
});

describe("missingFor", () => {
	const requirement = {
		session: ["setPlanModeState()", "navigateTree()", "sessionManager.getLeafId()"],
		pkg: ["VERSION", "AgentRegistry.global()"],
		modules: {
			"mod/btw": ["BtwHistoryStore.open()", "BtwHistoryStore.prototype.retry()", "getBtwTurns()"],
			"mod/gone": ["anything()"],
		},
		prompts: ["present.md", "absent.md"],
	};

	it("labels each missing internal by where it was looked up", () => {
		expect(missingFor(requirement, sources())).toEqual([
			"AgentSession.navigateTree",
			"AgentSession.sessionManager.getLeafId",
			"pi.AgentRegistry.global",
			"mod/btw#BtwHistoryStore.prototype.retry",
			"mod/gone",
			"prompts/absent.md",
		]);
	});

	it("skips session requirements while no session is attached", () => {
		expect(missingFor({ session: ["navigateTree()"] }, sources({ session: undefined }))).toEqual([]);
	});

	it("reports hidden labels as missing even when present", () => {
		const hidden = parseHidden(" AgentSession.setPlanModeState , mod/btw#getBtwTurns,,");
		expect([...hidden]).toEqual(["AgentSession.setPlanModeState", "mod/btw#getBtwTurns"]);
		expect(
			missingFor(
				{ session: ["setPlanModeState()"], modules: { "mod/btw": ["getBtwTurns()"] } },
				sources({ hidden }),
			),
		).toEqual(["AgentSession.setPlanModeState", "mod/btw#getBtwTurns"]);
	});
});

describe("deriveUnavailable", () => {
	it("groups missing internals by feature, in the order asked, omitting satisfied features", () => {
		const requirements = {
			planMode: { session: ["setPlanModeState()", "getPlanModeState()"] },
			loopMode: { modules: { "mod/btw": ["BtwHistoryStore.open()"] } },
			workspace: { session: ["sessionManager.addWorkspaceDirectory()"] },
		};
		expect(deriveUnavailable(["workspace", "loopMode", "planMode"], sources(), requirements)).toEqual([
			{ feature: "workspace", missing: ["AgentSession.sessionManager.addWorkspaceDirectory"] },
			{ feature: "planMode", missing: ["AgentSession.getPlanModeState"] },
		]);
	});

	it("covers every feature with a requirement and a renderer label", () => {
		expect(Object.keys(REQUIREMENTS).sort()).toEqual([...ALL_FEATURES].sort());
		for (const feature of ALL_FEATURES) expect(en[`bridgeHealth.feature.${feature}`], feature).toBeTruthy();
	});

	it("reports composer unavailable on an omp without the session members its methods read", () => {
		const members = [
			"AgentSession.disarmPrewalk",
			"AgentSession.autoRetryEnabled",
			"AgentSession.thinkingLevel",
			"AgentSession.configuredThinkingLevel",
		];
		const composer = { session: REQUIREMENTS.composer.session };
		expect(missingFor(composer, sources({ session: {} }))).toEqual(expect.arrayContaining(members));
		const current = {
			disarmPrewalk() {},
			get autoRetryEnabled() {
				return true;
			},
			get thinkingLevel() {
				return undefined;
			},
			configuredThinkingLevel() {},
		};
		const missing = missingFor(composer, sources({ session: current }));
		for (const member of members) expect(missing).not.toContain(member);
	});
});

describe("mergeAreaFailures", () => {
	it("marks every feature of a module that failed to load", () => {
		expect(
			mergeAreaFailures(
				[{ feature: "voice", missing: ["@x/stt#sttClient"] }],
				[{ area: "misc", features: ["voice", "ssh"], error: "Export named 'sttClient' not found" }],
			),
		).toEqual([
			{
				feature: "voice",
				missing: ["@x/stt#sttClient", "gui-bridge/misc.ts failed to load: Export named 'sttClient' not found"],
			},
			{ feature: "ssh", missing: ["gui-bridge/misc.ts failed to load: Export named 'sttClient' not found"] },
		]);
	});
});

describe("UnsupportedOmpError / requireFn", () => {
	it("names the feature and the missing internal under the unsupported_omp code", () => {
		const error = new UnsupportedOmpError(
			[{ feature: "planMode", missing: ["AgentSession.setPlanModeState"] }],
			"19.0.0",
		);
		expect(error.code).toBe("unsupported_omp");
		expect(error.message).toContain(`omp 19.0.0: ${FEATURES.planMode} (missing AgentSession.setPlanModeState)`);
		expect(error.message).toContain("omp update");
	});

	it("throws only when the method is absent", () => {
		expect(() => requireFn(fakeSession(), "setPlanModeState", "planMode")).not.toThrow();
		expect(() => requireFn(fakeSession(), "navigateTree", "sessionTree")).toThrow(
			expect.objectContaining({
				code: "unsupported_omp",
				message: expect.stringContaining("AgentSession.navigateTree"),
			}),
		);
		expect(() => requireFn({}, "getUsageStatistics", "usage", "SessionManager")).toThrow(
			/SessionManager\.getUsageStatistics/,
		);
	});
});

describe("health.ts loaders", () => {
	it("has a literal loader for every module the table names", () => {
		// omp only maps literal `@oh-my-pi/*` specifiers onto its live modules, so health.ts
		// spells each one out; a module without a loader would read as missing.
		const source = fs.readFileSync(path.join(BRIDGE_DIR, "health.ts"), "utf8");
		const loaders = [...source.matchAll(/"([^"]+)": \(\) =>\s*import\("([^"]+)"\)/g)];
		for (const [, key, specifier] of loaders) expect(specifier).toBe(key);
		const required = new Set(
			Object.values(REQUIREMENTS).flatMap(requirement => Object.keys(requirement.modules ?? {})),
		);
		expect(new Set(loaders.map(([, key]) => key))).toEqual(required);
	});
});
