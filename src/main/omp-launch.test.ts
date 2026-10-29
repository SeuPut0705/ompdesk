import { describe, expect, it } from "vitest";
import {
	type OmpLaunch,
	ompArgs,
	SESSION_OWNED_ENV,
	type SessionOpen,
	sessionEnv,
	sessionOpen,
	withoutSessionEnv,
} from "./omp-launch";

/** A launch with every extension, setting and origin there is. */
const FULL: OmpLaunch = {
	open: "new",
	bridge: { dir: "/bridge", address: "/tmp/omp-gui-1.sock" },
	builtin: {
		args: ["-e", "/builtin", "-e", "/builtin/rea"],
		root: "/builtin/rea",
		// sidecar-factory.ts `builtinMcp` with every pack and memory on.
		env: { OMP_GUI_PSTACK: "1", OMP_GUI_ECC: "1", OMP_GUI_MEMORY: "/ud/recall.json", OMP_GUI_REA_CACHE: "/ud/rea" },
	},
	userFlags: [],
	settings: {
		replyLanguage: "Korean",
		userProfile: { name: "Seu", experience: "expert" },
		nextPrompt: { suggestions: true, inline: true },
		autoTitle: { enabled: true, evolve: true, suppressed: false },
		judgeAssist: false,
		delegation: "swarm",
		accountRotation: "even",
		accountRotationLedger: "/ud/rotation.json",
		ompdeskRolesFile: "/ud/roles.json",
		browser: { kind: "ego" },
	},
	origin: { deviceId: "phone", name: "Phone", hostName: "Desk" },
};

describe("omp launch", () => {
	// A variable a spawn sets but never strips from what it inherits leaks one OMPdesk session's plumbing (its bridge
	// socket, delegation, memory file) into a tab started from that session's shell; a stale entry hides a removed one.
	it("strips exactly the variables a spawn sets for its session from what it inherits", () => {
		expect(Object.keys(sessionEnv(FULL)).sort()).toEqual([...SESSION_OWNED_ENV].sort());
		const inherited = { ...sessionEnv(FULL), PATH: "/bin", HOME: "/home/seu" };
		expect(withoutSessionEnv(inherited)).toEqual({ PATH: "/bin", HOME: "/home/seu" });
	});

	it("leaves out each setting at its default", () => {
		const bare: OmpLaunch = { open: "default", builtin: { args: [] }, userFlags: [], settings: {} };
		expect(sessionEnv(bare)).toEqual({});
		expect(
			sessionEnv({ ...bare, settings: { delegation: "default", userProfile: { name: "", experience: null } } }),
		).toEqual({});
		expect(ompArgs(bare)).toEqual(["--mode", "rpc-ui"]);
	});

	it("opens a tab's session by the one rule, for every combination of what the tab knows", () => {
		const written = new Set(["/s/written.jsonl"]);
		for (const path of [null, "/s/written.jsonl", "/s/unwritten.jsonl"]) {
			for (const isNew of [false, true]) {
				const open: SessionOpen = sessionOpen({ path, isNew }, file => written.has(file));
				// A written session is always reopened.
				if (path && written.has(path)) expect(open).toEqual({ session: path });
				// `--session` never names a file stock never wrote ("Session not found").
				else expect(open).not.toHaveProperty("session");
				// A new tab, or one whose session stock has not written yet, never lets autoResume pick another session.
				if (isNew || path) expect(open).not.toBe("default");
			}
		}
	});
});
