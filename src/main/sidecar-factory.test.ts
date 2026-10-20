import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AutoTitleSettings } from "../../resources/gui-bridge/modes/auto-title-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { BridgeHealth } from "./bridge-health";
import { SessionKindStore } from "./session-kinds";
import type { SidecarOptions } from "./sidecar";
import { localSidecarFactory } from "./sidecar-factory";

const created = vi.hoisted(() => [] as SidecarOptions[]);

// The factory only builds options; what a SidecarManager does with them is sidecar.test.ts's.
vi.mock("./sidecar", () => ({
	SidecarManager: class {
		constructor(options: SidecarOptions) {
			created.push(options);
		}
		on(): this {
			return this;
		}
	},
}));
// i18n opens the Electron prefs store on import.
vi.mock("./i18n", () => ({ ompFailureText: (reason: string) => reason }));
vi.mock("electron", () => ({ app: {} }));

describe("localSidecarFactory", () => {
	it("hands every tab it spawns, hosted ones included, the stored launch profiles", () => {
		let stored: unknown = { "/w/alpha": { noRules: true } };
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => undefined,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			delegationPref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => stored,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			// Read per spawn, not captured at creation.
			stored = { "/w/alpha": { noRules: true } };
			expect(options.launchProfiles?.()).toEqual({ "/w/alpha": { noRules: true } });
			stored = {};
			expect(options.launchProfiles?.()).toEqual({});
		}
	});

	it("hands every tab the prompt-suggestion switches, read per use, so a hosted tab follows this machine's pref", () => {
		let stored: NextPromptSettings = { suggestions: true, inline: true };
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => undefined,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => stored,
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			expect(options.nextPrompt?.()).toEqual({ suggestions: true, inline: true });
			stored = { suggestions: true, inline: false };
			expect(options.nextPrompt?.()).toEqual({ suggestions: true, inline: false });
			stored = { suggestions: true, inline: true };
		}
	});

	it("hands every tab the automatic-title switches, read per use, so a hosted tab follows this machine's pref", () => {
		let stored: AutoTitleSettings = { enabled: true, evolve: true, suppressed: false };
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => undefined,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => stored,
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			expect(options.autoTitle?.()).toEqual({ enabled: true, evolve: true, suppressed: false });
			stored = { enabled: true, evolve: false, suppressed: false };
			expect(options.autoTitle?.()).toEqual({ enabled: true, evolve: false, suppressed: false });
			stored = { enabled: true, evolve: true, suppressed: false };
		}
	});

	it("hands every tab the judge-assist switch, read per use, so a hosted tab follows this machine's pref", () => {
		let stored = true;
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => undefined,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => stored,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			stored = true;
			expect(options.judgeAssist?.()).toBe(true);
			stored = false;
			expect(options.judgeAssist?.()).toBe(false);
		}
	});

	it.each([
		[undefined, "agent", true, "1"],
		[true, "agent", true, "1"],
		[true, "chat", true, "0"],
		[false, "agent", false, "0"],
	] as const)("loads the pstack pack only while the switch is on (pref %s, %s)", async (stored, kind, on, flag) => {
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => false,
			pstackPref: () => stored,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
		});
		create("/w/alpha", kind, false);
		const mcp = await created[0]?.builtinMcp?.();
		expect(mcp?.args).toEqual(on ? ["-e", path.join("/builtin", "pstack")] : []);
		expect(mcp?.env).toEqual({ OMP_GUI_PSTACK: flag, OMP_GUI_ECC: "0" });
	});

	it.each([
		[undefined, "agent", true, "1"],
		[true, "chat", true, "0"],
		[false, "agent", false, "0"],
		[false, "chat", false, "0"],
	] as const)(
		"loads the ECC root only while its switch is on, its hint for a project (pref %s, %s)",
		async (stored, kind, on, flag) => {
			created.length = 0;
			const create = localSidecarFactory({
				bridgeDir: "/bridge",
				builtinDir: "/builtin",
				builtinReaPref: () => false,
				eccPref: () => stored,
				proxyEnv: async () => ({}),
				bridgeHealth: new BridgeHealth(() => {}),
				sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
				replyLanguagePref: () => undefined,
				userProfilePref: () => undefined,
				nextPromptPrefs: () => ({ suggestions: true, inline: true }),
				autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
				judgeAssistPref: () => true,
				delegationPref: () => undefined,
				accountRotationPref: () => undefined,
				accountRotationLedger: "/ledger.json",
				launchProfilesPref: () => undefined,
			});
			create("/w/alpha", kind, false);
			const mcp = await created[0]?.builtinMcp?.();
			expect(mcp?.args).toEqual(on ? ["-e", path.join("/builtin", "ecc")] : []);
			expect(mcp?.env).toEqual({ OMP_GUI_PSTACK: "0", OMP_GUI_ECC: flag });
		},
	);

	it("hands every spawn ai-memory's extension root while memory is on, read at each spawn (tabs and hosted tabs alike)", async () => {
		let args: string[] = ["-e", "/ud/ai-memory/omp-ext"];
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => false,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
			aiMemoryExtensionArgs: async () => args,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		for (const options of created) {
			expect((await options.builtinMcp?.())?.args).toEqual(["-e", "/ud/ai-memory/omp-ext"]);
			args = [];
			expect((await options.builtinMcp?.())?.args).toEqual([]);
			args = ["-e", "/ud/ai-memory/omp-ext"];
		}
	});
});
