/**
 * GithubRenderer (linkedom): the entity card's state chip reads in the UI's language, whatever GitHub word stock puts
 * there: a PR or issue state, a draft PR, or a run's conclusion; a state GitHub adds later as GitHub spells it.
 */
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import type { ToolRendererProps } from "../ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// react-dom must load after linkedom's globals above, so these imports cannot be static.
const { createRoot } = await import("react-dom/client");
const { GithubRenderer } = await import("./GithubRenderer");

let root: Root | undefined;
let container: { remove: () => void } | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

async function chip(text: string, details: Record<string, unknown> = {}): Promise<string | undefined> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host;
	root = createRoot(host as unknown as Element);
	const props = {
		args: { op: "pr_view", repo: "o/r" },
		result: { content: [{ type: "text", text }], details },
		isPartial: false,
	} as unknown as ToolRendererProps;
	await act(async () => root?.render(createElement(I18nProvider, null, createElement(GithubRenderer, props))));
	return host.querySelector(".rounded-full")?.textContent ?? undefined;
}

describe("GithubRenderer state chip", () => {
	it("names a draft PR and a run's conclusion in Korean, an unknown state as GitHub spells it", async () => {
		setLanguageOverride("ko");
		expect(await chip("# Pull Request #7: Add a thing\nState: DRAFT")).toBe("초안");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Pull Request #7: Add a thing", { conclusion: "timed_out" })).toBe("시간 초과");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Issue #3: Broken\nState: OPEN")).toBe("열림");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await chip("# Issue #3: Broken\nState: BRAND_NEW")).toBe("brand new");
	});
});
