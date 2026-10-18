/**
 * The completion menu as the composer derives it from a draft: what the `/`, `$` and `@` menus list, in
 * which order, with which highlight spans, what they say under their rows (footer, rows not shown, an
 * incomplete file list) and which warning an unknown `/word` gets. Rendered with react-dom/client into a
 * linkedom document around a bare textarea; the caret sits at the end of the draft.
 */

import { parseHTML } from "linkedom";
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AvailableCommand } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { clearMentionFiles, listMentionFiles, MENTION_FS_MAX_ENTRIES } from "./input-area-utils";
import { type CompletionMenu, useCompletionMenu } from "./use-completion-menu";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
const ompWindow = window as unknown as Record<string, unknown>;
ompWindow.setTimeout = setTimeout;
ompWindow.clearTimeout = clearTimeout;

const t = (key: string, params?: Record<string, string | number>) => translate(key, params);

const command = (name: string, description = `${name} command`, aliases?: string[]): AvailableCommand =>
	({ name, description, source: "builtin", ...(aliases ? { aliases } : {}) }) as AvailableCommand;

const COMMANDS: AvailableCommand[] = [
	command("jobs"),
	command("plan"),
	command("model", "Pick the model", ["m"]),
	command("compact"),
	command("skill:review"),
	command("skill:tdd"),
	...Array.from({ length: 20 }, (_, index) => command(`extra${index}`)),
];

/** A builtin command's argument menu asks the sidecar; none has anything to offer here. */
const rpc = {
	getCommandArgCompletions: async () => ({ success: true, data: { items: [] } }),
	getAvailableModels: async () => ({ success: true, data: { models: [] } }),
};

function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

interface Derived {
	menu: CompletionMenu | null;
	hint: string;
}

let root: Root | undefined;
let latest: Derived;

function Probe({ text, filePaths, commands }: { text: string; filePaths: string[]; commands: AvailableCommand[] }) {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	const setMenu = useRef((menu: CompletionMenu | null) => {
		latest = { ...latest, menu };
	}).current;
	const hint = useCompletionMenu({ text, filePaths, commands, emojiAutocomplete: false, textareaRef: ref, setMenu });
	useEffect(() => {
		latest = { ...latest, hint };
	}, [hint]);
	return (
		<textarea
			defaultValue={text}
			ref={el => {
				ref.current = el;
				// linkedom has no selection model: the caret is at the end of the draft.
				if (el)
					Object.defineProperties(el, {
						selectionStart: { value: text.length, configurable: true },
						selectionEnd: { value: text.length, configurable: true },
					});
			}}
		/>
	);
}

/** Derive the menu for a draft (caret at its end) once the effects and async steps have settled. */
async function derive(text: string, filePaths: string[] = [], commands = COMMANDS): Promise<Derived> {
	latest = { menu: null, hint: "" };
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Probe text={text} filePaths={filePaths} commands={commands} />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await pause(5);
	});
	return latest;
}

const labels = (menu: CompletionMenu | null) => menu?.items.map(item => item.label) ?? [];

beforeEach(() => {
	ompWindow.omp = { fs: { list: vi.fn() }, rpc };
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
		root = undefined;
	}
	document.body.innerHTML = "";
	clearMentionFiles();
	useModelStore.getState().reset();
});

describe("the / menu", () => {
	it("lists every command for a bare slash, with nothing left to scroll to or hide", async () => {
		const { menu } = await derive("/");
		expect(menu?.items).toHaveLength(COMMANDS.length);
		expect(menu?.total).toBe(COMMANDS.length);
		expect(menu?.footer?.notes).toEqual([]);
	});

	it("keeps the best 20 of a typed name and says how many more there are", async () => {
		const { menu } = await derive("/e");
		expect(menu?.items).toHaveLength(20);
		expect(menu?.total).toBe(22);
		expect(menu?.footer?.notes).toEqual([t("input.menu.more", { count: 2 })]);
	});

	it("ranks an exact name before a prefix before a substring and marks the matched letters", async () => {
		const { menu } = await derive("/pla");
		expect(labels(menu)).toEqual(["/plan"]);
		expect(menu?.items[0]?.highlights).toEqual([[1, 4]]);
		const exact = await derive("/m");
		expect(labels(exact.menu)[0]).toBe("/model");
	});

	it("carries the keys that work in the menu as footer data", async () => {
		const { menu } = await derive("/");
		expect(menu?.footer?.hints).toEqual([
			{ keys: "↑↓", label: t("input.menu.hintMove") },
			{ keys: "Tab ↵", label: t("input.menu.hintPick") },
			{ keys: "Esc", label: t("input.menu.hintClose") },
		]);
	});

	it("warns on an unknown command instead of silently sending it as a prompt", async () => {
		const bare = await derive("/zzzz");
		expect(bare.menu).toBeNull();
		expect(bare.hint).toBe(t("input.slash.unknown", { name: "/zzzz" }));
		const withArgs = await derive("/zzzz some words");
		expect(withArgs.hint).toBe(t("input.slash.unknown", { name: "/zzzz" }));
		const known = await derive("/plan do it");
		expect(known.hint).toBe("");
		expect((await derive("/")).hint).toBe("");
	});

	it("stays quiet about an unknown name until the command list has loaded", async () => {
		expect((await derive("/zzzz", [], [])).hint).toBe("");
	});

	it("offers the skills on a stray slash after prose, all of them for a bare one", async () => {
		const { menu } = await derive("please /");
		expect(labels(menu)).toEqual(["/skill:review", "/skill:tdd"]);
	});
});

describe("the / menu with Hangul after the name (a keyboard left in Korean, an IME composing)", () => {
	it("keeps the menu open on the name typed so far and replaces the Hangul with the pick", async () => {
		const { menu } = await derive("/pla한");
		expect(labels(menu)).toEqual(["/plan"]);
		expect(menu?.rangeStart).toBe(0);
		expect(menu?.rangeEnd).toBe(5);
	});

	it("lists everything for a slash followed only by jamo, and does not call it unknown", async () => {
		const { menu, hint } = await derive("/ㅔ");
		expect(menu?.items).toHaveLength(COMMANDS.length);
		expect(hint).toBe("");
	});

	it("works the same after prose, and for the $ menu", async () => {
		const prose = await derive("say /sk하");
		expect(labels(prose.menu)).toEqual(["/skill:review", "/skill:tdd"]);
		const dollar = await derive("$td한");
		expect(labels(dollar.menu)).toEqual(["$tdd"]);
		expect(dollar.menu?.rangeStart).toBe(0);
	});
});

describe("the $ menu", () => {
	it("lists every skill for a bare dollar and marks the matched letters of a typed name", async () => {
		const all = await derive("$");
		expect(labels(all.menu)).toEqual(["$review", "$tdd"]);
		const typed = await derive("$dd");
		expect(labels(typed.menu)).toEqual(["$tdd"]);
		expect(typed.menu?.items[0]?.highlights).toEqual([[2, 4]]);
	});
});

describe("the @ menu", () => {
	const files = [
		"docs/한글문서.md",
		"e2e/app-auto-update.e2e.ts",
		"src/renderer/App.tsx",
		"src/renderer/InputArea.tsx",
	];

	it("ranks by file name and gives the spans to highlight", async () => {
		const { menu } = await derive("@app", files);
		expect(labels(menu)[0]).toBe("src/renderer/App.tsx");
		expect(menu?.items[0]?.highlights).toEqual([[13, 16]]);
		expect(menu?.items[0]?.value).toBe("@src/renderer/App.tsx ");
	});

	it("finds a Hangul file name by its initial consonants", async () => {
		const { menu } = await derive("@ㅎㄱ", files);
		expect(labels(menu)).toEqual(["docs/한글문서.md"]);
		expect(menu?.items[0]?.highlights).toEqual([[5, 7]]);
	});

	it("matches a decomposed (NFD) name and inserts the name as it is on disk", async () => {
		const decomposed = "docs/한글문서.md".normalize("NFD");
		const { menu } = await derive("@한글", [decomposed]);
		expect(labels(menu)).toEqual(["docs/한글문서.md"]);
		expect(menu?.items[0]?.value).toBe(`@${decomposed} `);
	});

	it("keeps the internal schemes below the files, highlighted", async () => {
		const { menu } = await derive("@ski", files);
		expect(labels(menu)).toEqual(["skill://"]);
		expect(menu?.items[0]?.highlights).toEqual([[0, 3]]);
	});

	describe("a listing cut at main's entry cap", () => {
		const tree = (paths: string[]) => ({
			ok: true,
			entries: paths.map(path => ({ kind: "file", path, name: path })),
			truncated: true,
		});

		async function cutListing(): Promise<{ paths: string[]; list: Mock }> {
			const list = vi.fn(async (dir?: string) =>
				dir === "pkg/deep"
					? tree(["pkg/deep/needle-file.ts", "pkg/deep/other.ts"])
					: tree(["pkg/a.ts", "pkg/b.ts"]),
			);
			ompWindow.omp = { fs: { list }, rpc };
			return { paths: await listMentionFiles("/w", "t1", 1), list };
		}

		it("asks main for the walk's cap and flags the list as cut", async () => {
			const { paths, list } = await cutListing();
			expect(list).toHaveBeenCalledWith(undefined, 16, MENTION_FS_MAX_ENTRIES, "t1");
			const { menu } = await derive("@a.ts", paths);
			expect(menu?.truncated).toBe(true);
			expect(menu?.footer?.notes).toEqual([
				t("input.menu.filesTruncated", { count: MENTION_FS_MAX_ENTRIES.toLocaleString() }),
			]);
		});

		it("says so in the hint line when nothing matches, instead of an unexplained empty list", async () => {
			const { paths } = await cutListing();
			const { menu, hint } = await derive("@needle-file", paths);
			expect(menu).toBeNull();
			expect(hint).toBe(t("input.menu.filesTruncated", { count: MENTION_FS_MAX_ENTRIES.toLocaleString() }));
		});

		it("lists a typed folder on its own, so a longer path reaches a file the walk missed", async () => {
			const { paths, list } = await cutListing();
			// First pass: the folder is not loaded yet, the debounce asks for it.
			await derive("@pkg/deep/needle", paths);
			await act(async () => {
				await pause(250);
			});
			expect(list).toHaveBeenCalledWith("pkg/deep", 16, MENTION_FS_MAX_ENTRIES, "t1");
			expect(labels(latest.menu)).toEqual(["pkg/deep/needle-file.ts"]);
			expect(latest.menu?.truncated).toBe(true); // that folder's own listing was cut as well in this fixture
		});
	});

	it("shows a complete list without a cut notice", async () => {
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({
					ok: true,
					entries: [{ kind: "file", path: "a.ts", name: "a.ts" }],
					truncated: false,
				})),
			},
			rpc,
		};
		const paths = await listMentionFiles("/w", "t1", 1);
		const { menu } = await derive("@a", paths);
		expect(menu?.truncated).toBe(false);
		expect(menu?.footer?.notes).toEqual([]);
	});
});
