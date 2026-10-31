import { describe, expect, it } from "vitest";
import { BOT_PREF } from "../../shared/agent-control";
import { BotHome } from "./bot-home";

const WORK = "/home/me/.omp/work";

/** A fake stock: `create` hands out a new file per call, `files` is what exists, `deleted` the tombstones. */
function rig(options: { named?: string; language?: "en" | "ko" } = {}) {
	const prefs = new Map<string, unknown>();
	if (options.named) prefs.set(BOT_PREF, options.named);
	const files = new Set<string>(options.named ? [options.named] : []);
	const deleted = new Set<string>();
	const created: { cwd: string; title: string }[] = [];
	const chats: string[] = [];
	const changed: string[] = [];
	let gate: PromiseWithResolvers<void> | null = null;
	const home = new BotHome({
		prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
		deleted: sessionPath => deleted.has(sessionPath),
		workspace: () => WORK,
		title: () => (options.language === "ko" ? "봇" : "Bot"),
		create: async input => {
			created.push(input);
			await gate?.promise;
			const sessionPath = `/sessions/work/${created.length}.jsonl`;
			files.add(sessionPath);
			return { sessionPath, sessionId: `id-${created.length}` };
		},
		markChat: sessionId => void chats.push(sessionId),
		changed: key => void changed.push(key),
		exists: sessionPath => files.has(sessionPath),
	});
	return {
		home,
		prefs,
		files,
		deleted,
		created,
		chats,
		changed,
		/** The next `create` waits until `finish`. */
		hold: () => {
			gate = Promise.withResolvers<void>();
		},
		finish: () => gate?.resolve(),
	};
}

describe("ensureBotSession", () => {
	it("makes the session at the first launch: in the Work workspace, titled, a chat, named by the pref", async () => {
		const r = rig();
		const file = await r.home.ensureBotSession();
		expect(r.created).toEqual([{ cwd: WORK, title: "Bot" }]);
		expect(r.chats).toEqual(["id-1"]);
		expect(file).toBe("/sessions/work/1.jsonl");
		expect(r.prefs.get(BOT_PREF)).toBe(file);
		expect(r.changed).toEqual([BOT_PREF]);
	});

	it("titles it by the UI language", async () => {
		const r = rig({ language: "ko" });
		await r.home.ensureBotSession();
		expect(r.created).toEqual([{ cwd: WORK, title: "봇" }]);
	});

	it("keeps the file the pref names while it exists and was never deleted", async () => {
		const r = rig({ named: "/sessions/work/kept.jsonl" });
		expect(await r.home.ensureBotSession()).toBe("/sessions/work/kept.jsonl");
		expect(r.created).toEqual([]);
		expect(r.changed).toEqual([]);
	});

	it("makes a new one when the file is gone or the owner deleted it, and names that one from then on", async () => {
		const missing = rig({ named: "/sessions/work/gone.jsonl" });
		missing.files.clear();
		const fresh = await missing.home.ensureBotSession();
		expect(fresh).toBe("/sessions/work/1.jsonl");
		expect(missing.prefs.get(BOT_PREF)).toBe(fresh);

		const tombstoned = rig({ named: "/sessions/work/deleted.jsonl" });
		tombstoned.deleted.add("/sessions/work/deleted.jsonl");
		const replaced = await tombstoned.home.ensureBotSession();
		expect(replaced).toBe("/sessions/work/1.jsonl");
		expect(tombstoned.prefs.get(BOT_PREF)).toBe(replaced);
		expect(tombstoned.changed).toEqual([BOT_PREF]);
	});

	it("is idempotent: a second pass, and a launch racing a click, make one session", async () => {
		const r = rig();
		r.hold();
		const launch = r.home.ensureBotSession();
		const click = r.home.ensureBotSession();
		r.finish();
		const [first, second] = await Promise.all([launch, click]);
		expect(second).toBe(first);
		expect(await r.home.ensureBotSession()).toBe(first);
		expect(r.created).toHaveLength(1);
		expect(r.changed).toEqual([BOT_PREF]);
	});

	it("tries again after a failure, and names nothing until a session exists", async () => {
		const prefs = new Map<string, unknown>();
		let calls = 0;
		const home = new BotHome({
			prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
			deleted: () => false,
			workspace: () => WORK,
			title: () => "Bot",
			create: async () => {
				if (++calls === 1) throw new Error("omp is not ready");
				return { sessionPath: "/sessions/work/second.jsonl", sessionId: "id" };
			},
			markChat: () => {},
			changed: () => {},
			exists: () => false,
		});
		await expect(home.ensureBotSession()).rejects.toThrow("omp is not ready");
		expect(prefs.has(BOT_PREF)).toBe(false);
		expect(await home.ensureBotSession()).toBe("/sessions/work/second.jsonl");
	});
});
