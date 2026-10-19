/**
 * Stats › Requests with real-shaped rows: the status reads as words, not
 * stock's raw `toolUse`; a model id stays on one line instead of breaking at
 * its hyphens; the request total and dollar amounts are grouped.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { RequestPage, RequestRow } from "../../../shared/stats-types";
import { formatUsd } from "../../lib/format";
import { I18nProvider } from "../../lib/i18n";
import { projectLabel } from "./ProjectsRoute";
import { RequestsRoute } from "./RequestsRoute";

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
Object.assign(window, { setInterval, clearInterval, setTimeout, clearTimeout });

function row(id: number, stopReason: string, errorMessage: string | null = null): RequestRow {
	return {
		id,
		entryId: `entry-${id}`,
		sessionFile: "/sessions/a.jsonl",
		folder: "-Desktop-GitHub-omgdesk",
		model: "claude-opus-5-5",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: Date.UTC(2026, 9, 10, 1, 36, 59) + id,
		duration: 2400,
		ttft: 2100,
		stopReason,
		errorMessage,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 130_800, cost: { total: 0.03 } },
	} as RequestRow;
}

let root: Root | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

it("words stop reasons, keeps model ids on one line and groups the total", async () => {
	const page: RequestPage = {
		rows: [row(1, "toolUse"), row(2, "stop"), row(3, "error", "overloaded"), row(4, "somethingNew")],
		total: 32_181,
		nextCursor: null,
		snapshotAt: Date.UTC(2026, 9, 10),
	};
	Object.assign(window, { omp: { stats: { fetch: async () => page } } });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<RequestsRoute range="90d" />
			</I18nProvider>,
		);
	});

	const text = container.textContent ?? "";
	expect(text).toContain("Recent requests (32,181)");
	expect(text).toContain("Tool call");
	expect(text).toContain("Done");
	expect(text).toContain("Error");
	expect(text).not.toContain("toolUse");
	// An unknown reason from a newer omp still shows as is.
	expect(text).toContain("somethingNew");
	const model = [...container.querySelectorAll("span")].find(node => node.textContent === "claude-opus-5-5");
	expect(model?.className).toContain("whitespace-nowrap");
});

it("groups dollar amounts past a thousand", () => {
	expect(formatUsd(2888.15)).toBe("$2,888.15");
	expect(formatUsd(12.5)).toBe("$12.50");
	expect(formatUsd(0.004)).toBe("$0.0040");
});

it("reads a stats folder without stock's scope dashes or path noise, never splitting hyphenated names", () => {
	expect(projectLabel("-Desktop-GitHub-omgdesk")).toBe("Desktop-GitHub-omgdesk");
	expect(projectLabel("--work--pi--")).toBe("work--pi");
	expect(projectLabel("/private-tmp/")).toBe("private-tmp");
	expect(projectLabel("/home/dev/projects/workspace-alpha")).toBe("workspace-alpha");
});
