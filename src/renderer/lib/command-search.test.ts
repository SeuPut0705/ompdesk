/**
 * Command palette ranking (exact > prefix > word-prefix > substring > fuzzy,
 * Hangul jamo/initial-consonant aware, recents boosted within a tier) and
 * the Enter guard for turn-starting / destructive commands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../locales/ko";
import { useTabsStore } from "../stores/tabs";
import { buildCurrentCommandMenu, type CommandMenuItem, commandGuard } from "./command-registry";
import {
	decomposeHangul,
	enterNeedsConfirm,
	MatchTier,
	matchCommand,
	rankCommands,
	type SearchableCommand,
} from "./command-search";

const names = (query: string, items: SearchableCommand[], recent: string[] = []) =>
	rankCommands(items, query, recent).map(entry => entry.item.name);

const KO_ITEMS: SearchableCommand[] = [
	{ name: "worktree", label: "워크트리 만들기", description: "새 워크트리에서 세션 시작" },
	{ name: "cleanup", label: "정리", description: "세션 트리의 오래된 분기 정리" },
	{ name: "branch", label: "분기", description: "세션 분기 만들기" },
	{ name: "tree", label: "세션 트리", description: "분기 탐색" },
	{ name: "new", label: "새 세션", description: "빈 세션 시작" },
];

describe("tier order", () => {
	const items: SearchableCommand[] = [
		{ name: "f", label: "pXlXaXn" },
		{ name: "s", label: "explanation" },
		{ name: "w", label: "review plan" },
		{ name: "p", label: "planner" },
		{ name: "e", label: "Plan" },
	];

	it("ranks exact > prefix > word-prefix > substring > fuzzy", () => {
		expect(names("plan", items)).toEqual(["e", "p", "w", "s", "f"]);
		expect(matchCommand("plan", items[0])?.tier).toBe(MatchTier.fuzzy);
		expect(matchCommand("plan", items[4])?.tier).toBe(MatchTier.exact);
	});

	it("matches the command name and aliases, and ignores a leading slash", () => {
		const list: SearchableCommand[] = [
			{ name: "model-roles", label: "Model roles" },
			{ name: "quit", label: "Quit seucode", aliases: ["exit"] },
		];
		expect(names("/exit", list)).toEqual(["quit"]);
		expect(matchCommand("/quit", list[1])?.tier).toBe(MatchTier.exact);
	});

	it("puts description-only hits after hits on the command's own words, and never fuzzy-matches prose", () => {
		const list: SearchableCommand[] = [
			{ name: "a", label: "Stats", description: "Session plan overview" },
			{ name: "b", label: "Explanation" },
		];
		expect(names("plan", list)).toEqual(["b", "a"]);
		expect(matchCommand("xyz", { name: "c", label: "Copy", description: "x y z" })).toBeNull();
	});

	it("keeps registry order for an empty query", () => {
		expect(names("", items)).toEqual(items.map(item => item.name));
	});
});

describe("Korean", () => {
	it('ranks "세션 트리" first for "트리"', () => {
		expect(names("트리", KO_ITEMS)[0]).toBe("tree");
		// word-prefix (세션 트리) > substring (워크트리 …) > description-only (정리)
		expect(names("트리", KO_ITEMS)).toEqual(["tree", "worktree", "cleanup"]);
	});

	it('ranks the real ko "cmd.tree" label first among every ko command label', () => {
		const strings = ko as Record<string, string>;
		const commands: SearchableCommand[] = Object.keys(strings)
			.filter(key => key.startsWith("cmd.") && !key.endsWith(".desc"))
			.map(key => ({ name: key, label: strings[key], description: strings[`${key}.desc`] }));
		expect(names("트리", commands)[0]).toBe("cmd.tree");
	});

	it("matches a syllable still being composed (jamo-aware)", () => {
		// Typing 트리 passes through 틀 (ㅌㅡㄹ) before the IME splits it.
		expect(decomposeHangul("틀")).toBe("ㅌㅡㄹ");
		expect(names("틀", KO_ITEMS)[0]).toBe("tree");
		expect(names("세ㅅ", KO_ITEMS)).toContain("new");
		// A half-typed syllable is never an exact hit.
		expect(matchCommand("세션 틀", KO_ITEMS[3])?.tier).toBe(MatchTier.prefix);
	});

	it("matches initial consonants (choseong)", () => {
		expect(names("ㅌㄹ", KO_ITEMS)[0]).toBe("tree");
		expect(names("ㅅㅅ ㅌㄹ", KO_ITEMS)[0]).toBe("tree");
		expect(names("ㅅ ㅅ", KO_ITEMS)).toContain("new");
	});
});

describe("recents", () => {
	const items: SearchableCommand[] = [
		{ name: "theme", label: "Change theme" },
		{ name: "tools", label: "Change tools" },
		{ name: "change", label: "Change" },
	];

	it("boosts a recently used command within its tier", () => {
		expect(names("chan", items)).toEqual(["theme", "tools", "change"]);
		expect(names("chan", items, ["tools"])).toEqual(["tools", "theme", "change"]);
	});

	it("never lifts a recent command over a better tier", () => {
		expect(names("change", items, ["tools"])[0]).toBe("change");
	});
});

describe("Enter guard", () => {
	const exact = matchCommand("resend", { name: "resend", label: "Resend" });
	const prefix = matchCommand("res", { name: "resend", label: "Resend" });
	const fuzzy = matchCommand("rsnd", { name: "resend", label: "Resend" });

	it("lets unguarded commands run from any match", () => {
		expect(enterNeedsConfirm(undefined, fuzzy, false)).toBe(false);
	});

	it("requires confirmation for a guarded command on a partial or fuzzy match", () => {
		expect(fuzzy?.tier).toBe(MatchTier.fuzzy);
		expect(enterNeedsConfirm("turn", fuzzy, false)).toBe(true);
		expect(enterNeedsConfirm("destructive", prefix, false)).toBe(true);
		// Empty query: the auto-selected first row (often a recent) is not a choice.
		expect(enterNeedsConfirm("turn", matchCommand("", { name: "resend", label: "Resend" }), false)).toBe(true);
	});

	it("runs a guarded command on an exact query or an explicit (arrow-key) selection", () => {
		expect(enterNeedsConfirm("destructive", exact, false)).toBe(false);
		expect(enterNeedsConfirm("turn", fuzzy, true)).toBe(false);
	});
});

describe("registry guard metadata", () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>).window = { omp: { rpc: {} }, dispatchEvent: vi.fn() };
		useTabsStore.setState({
			tabs: [{ id: "t", cwd: "/tmp", status: "ready", kind: "agent", unreadDone: false }],
			activeTabId: "t",
		});
	});
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).window;
		useTabsStore.setState({ tabs: [], activeTabId: null });
	});

	const menu = () =>
		buildCurrentCommandMenu([
			{ name: "hello", description: "Say hello", textModeExecutable: true },
			{ name: "deploy", description: "Deploy", input: { hint: "<env>" }, textModeExecutable: true },
		]);
	const item = (name: string): CommandMenuItem => {
		const found = menu().find(candidate => candidate.name === name);
		if (!found) throw new Error(`missing menu item: ${name}`);
		return found;
	};

	it("marks turn-starting and destructive commands", () => {
		for (const name of ["retry", "resend", "guided-goal"]) expect(commandGuard(item(name)), name).toBe("turn");
		for (const name of ["delete", "clear", "compact", "quit", "restart"])
			expect(commandGuard(item(name)), name).toBe("destructive");
		for (const name of ["model", "settings", "tree", "new-tab"])
			expect(commandGuard(item(name)), name).toBeUndefined();
	});

	it("treats a dispatched sidecar prompt as turn-starting, but not one that only prefills the composer", () => {
		expect(commandGuard(item("hello"))).toBe("turn");
		expect(commandGuard(item("deploy"))).toBeUndefined();
	});
});
