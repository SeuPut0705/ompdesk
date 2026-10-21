/**
 * GitHub Actions run detail (linkedom): "Re-run failed jobs" and "Failed jobs' log" show for a run that did not pass
 * by GitHub's rule (success, neutral and skipped pass), so a neutral run never offers to re-run jobs that did not fail.
 */

import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubRunDetail } from "../../../../shared/github";
import { I18nProvider, setLanguageOverride, translate } from "../../../lib/i18n";
import { RunDetail } from "./GithubActions";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// react-dom must load after linkedom's globals above, so this import cannot be static.
const { createRoot } = await import("react-dom/client");

let root: Root | undefined;
let container: { remove: () => void } | undefined;

const RUN: GithubRunDetail = {
	id: 1,
	workflow: "CI",
	title: "fix things",
	status: "completed",
	conclusion: "success",
	branch: "main",
	event: "push",
	createdAt: "2026-10-21T00:00:00Z",
	url: "https://github.com/o/r/actions/runs/1",
	jobs: [],
};

async function offersFailedRerun(conclusion: string): Promise<boolean> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host;
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			createElement(
				I18nProvider,
				null,
				createElement(RunDetail, {
					run: { ...RUN, conclusion },
					target: { host: "github.com", repo: "o/r" },
					onChanged: () => {},
				}),
			),
		),
	);
	const labels = [...host.querySelectorAll("button")].map(button => button.textContent);
	return labels.includes(translate("github.runs.rerunFailed"));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

describe("Actions run detail", () => {
	it("offers to re-run failed jobs only for a run that did not pass", async () => {
		setLanguageOverride("en");
		const offered: Record<string, boolean> = {};
		for (const conclusion of ["success", "neutral", "skipped", "failure", "cancelled", "timed_out"]) {
			offered[conclusion] = await offersFailedRerun(conclusion);
			await act(async () => root?.unmount());
			container?.remove();
		}
		expect(offered).toEqual({
			success: false,
			neutral: false,
			skipped: false,
			failure: true,
			cancelled: true,
			timed_out: true,
		});
	});
});
