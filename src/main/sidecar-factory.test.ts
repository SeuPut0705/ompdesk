import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AutoTitleSettings } from "../../resources/gui-bridge/modes/auto-title-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { BridgeHealth } from "./bridge-health";
import { setControlEndpoint } from "./control-socket/env";
import { SessionKindStore } from "./session-kinds";
import type { SidecarOptions } from "./sidecar";
import { localSidecarFactory } from "./sidecar-factory";

/** The formal-verification skill root rides on every spawn, after the switchable packs. */
const FORMAL = ["-e", path.join("/builtin", "formal")];
const created = vi.hoisted(() => [] as SidecarOptions[]);
const reaProbes = vi.hoisted(() => ({ count: 0 }));
const sidecars = vi.hoisted(() => [] as Array<{ listeners: Map<string, Array<(arg: unknown) => void>> }>);

// The factory only builds options; what a SidecarManager does with them is sidecar.test.ts's.
vi.mock("./sidecar", () => ({
	SidecarManager: class {
		readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
		constructor(options: SidecarOptions) {
			created.push(options);
			sidecars.push(this);
		}
		on(event: string, listener: (arg: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
	},
}));
// i18n opens the Electron prefs store on import.
vi.mock("./i18n", () => ({ ompFailureText: (reason: string) => reason }));
vi.mock("electron", () => ({ app: {} }));
// The node/npx probe runs real processes (seconds on Windows); these tests count it instead.
vi.mock("./builtin-mcp", () => ({
	builtinReaState: async (pref: unknown) => {
		reaProbes.count++;
		return { enabled: pref !== false, available: true, nodeVersion: "v24.0.0" };
	},
}));

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

	it("tells only this computer's own tabs where the control socket is; a paired device's or the phone page's tab is told it is off", () => {
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
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
		});
		setControlEndpoint({ socket: "/s/control.sock", dir: "/s" });
		try {
			create("/w/alpha", "agent", false);
			create("/w/alpha", "agent", false, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
			create("/w/alpha", "agent", false, undefined, true);
			const [own, device, phone] = created.map(options => options.controlEnv?.());
			expect(own).toEqual({ OMPDESK_SOCKET: "/s/control.sock", OMPDESK_CONTROL_DIR: "/s" });
			expect(device).toEqual({ OMPDESK_CONTROL_OFF: "1" });
			expect(phone).toEqual({ OMPDESK_CONTROL_OFF: "1" });
		} finally {
			setControlEndpoint(null);
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
		expect(mcp?.args).toEqual([...(on ? ["-e", path.join("/builtin", "pstack")] : []), ...FORMAL]);
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
			expect(mcp?.args).toEqual([...(on ? ["-e", path.join("/builtin", "ecc")] : []), ...FORMAL]);
			expect(mcp?.env).toEqual({ OMP_GUI_PSTACK: "0", OMP_GUI_ECC: flag });
		},
	);

	it("hands every spawn ai-memory's extension root while memory is on, read at each spawn (tabs and hosted tabs alike)", async () => {
		let args: string[] = ["-e", "/ud/ai-memory/omp-ext"];
		const asked: string[] = [];
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
			aiMemoryExtensionArgs: async cwd => {
				asked.push(cwd);
				return args;
			},
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		for (const options of created) {
			expect((await options.builtinMcp?.())?.args).toEqual([...FORMAL, "-e", "/ud/ai-memory/omp-ext"]);
			args = [];
			expect((await options.builtinMcp?.())?.args).toEqual(FORMAL);
			args = ["-e", "/ud/ai-memory/omp-ext"];
		}
		// The extension flags depend on the folder (a project's own disabled list), so each spawn names its own.
		expect(asked).toEqual(Array(asked.length).fill("/w/alpha"));
		expect(asked.length).toBeGreaterThan(0);
	});

	it("asks for Node only while the built-in REA is on", async () => {
		let rea: unknown = false;
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			builtinReaPref: () => rea,
			reaCacheDir: "/ud/rea",
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
		create("/w/alpha", "agent", false);
		const [options] = created;
		reaProbes.count = 0;

		const off = await options?.builtinMcp?.();
		expect(off?.args).toEqual(FORMAL);
		expect(off?.env).not.toHaveProperty("OMP_GUI_REA_CACHE");
		expect(reaProbes.count).toBe(0);
		rea = true;
		const on = await options?.builtinMcp?.();
		expect(on?.args).toEqual(["-e", path.join("/builtin", "rea"), ...FORMAL]);
		expect(on?.env).toMatchObject({ OMP_GUI_REA_CACHE: "/ud/rea" });
		expect(reaProbes.count).toBe(1);
	});

	it("wakes the shared-checkout pass on the bridge's checkout_files frame of any tab, and on no other frame", () => {
		const wakes: string[] = [];
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
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchProfilesPref: () => undefined,
			checkoutFiles: owner => wakes.push(owner === sidecars.at(-1) ? "pass" : "other"),
		});
		const emitFrame = (type: string) => {
			for (const listener of sidecars.at(-1)?.listeners.get("frame") ?? []) listener({ type });
		};
		create("/w/alpha", "agent", false);
		emitFrame("message_update");
		expect(wakes).toEqual([]);
		emitFrame("checkout_files");
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		emitFrame("checkout_files");
		expect(wakes).toEqual(["pass", "pass"]);
	});
});
