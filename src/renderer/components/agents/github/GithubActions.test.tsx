/**
 * GitHub Actions (linkedom): "Re-run failed jobs" shows for a run that did not pass by GitHub's rule (success, neutral
 * and skipped pass), so a neutral run never offers to re-run jobs that did not fail; and Run workflow starts on the
 * repository's default branch when no branch is typed, as `gh workflow run` does.
 */

import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubRunDetail } from "../../../../shared/github";
import { I18nProvider, setLanguageOverride, translate } from "../../../lib/i18n";
import { GithubActions, RunDetail } from "./GithubActions";

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

async function mountRun(run: Partial<GithubRunDetail>): Promise<Element> {
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
					run: { ...RUN, ...run },
					target: { host: "github.com", repo: "o/r" },
					onChanged: () => {},
				}),
			),
		),
	);
	return host as unknown as Element;
}

async function offersFailedRerun(conclusion: string): Promise<boolean> {
	const host = await mountRun({ conclusion });
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

	it("names what started the run in the UI's language, and an event GitHub adds later as GitHub spells it", async () => {
		setLanguageOverride("ko");
		const meta = async (event: string) =>
			(await mountRun({ event })).querySelector("[data-github-run-event]")?.textContent;
		expect(await meta("pull_request")).toBe("풀 리퀘스트");
		await act(async () => root?.unmount());
		container?.remove();
		expect(await meta("brand_new_event")).toBe("brand new event");
	});
});

describe("Actions run workflow", () => {
	function fire(element: unknown, handler: string, event: unknown): void {
		const record = element as Record<string, unknown>;
		const key = Object.keys(record).find(name => name.startsWith("__reactProps$"));
		const props = record[key as string] as Record<string, (event: unknown) => void>;
		props[handler]?.(event);
	}

	async function mountActions(state: string): Promise<{ host: Element; sent: unknown[] }> {
		const sent: unknown[] = [];
		(window as unknown as { omp: unknown }).omp = {
			rpc: {
				command: async (command: { request: { op: string } }) => {
					sent.push(command.request);
					const data =
						command.request.op === "workflow_list"
							? [{ id: 9, name: "Deploy", path: ".github/workflows/deploy.yml", state }]
							: command.request.op === "workflow_dispatch"
								? { ok: true }
								: [];
					return { type: "response", command: "github", success: true, data };
				},
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		container = host;
		root = createRoot(host as unknown as Element);
		await act(async () =>
			root?.render(
				createElement(
					I18nProvider,
					null,
					createElement(GithubActions, { target: { repo: "o/r" }, repoName: "o/r", targetKey: "o/r" }),
				),
			),
		);
		await act(async () => fire(host.querySelector("select"), "onChange", { target: { value: "9" } }));
		return { host: host as unknown as Element, sent };
	}

	const runButton = (host: Element) =>
		[...host.querySelectorAll("button")].find(button => button.textContent === translate("github.runs.dispatch"));

	it("says why Run workflow is off for a workflow turned off on GitHub", async () => {
		setLanguageOverride("en");
		const { host } = await mountActions("disabled_manually");
		expect(runButton(host)?.hasAttribute("disabled")).toBe(true);
		expect(runButton(host)?.getAttribute("title")).toBe(translate("github.runs.workflowOff"));
	});

	it("starts the workflow on the default branch when no branch is typed", async () => {
		setLanguageOverride("en");
		const { host, sent } = await mountActions("active");
		await act(async () => fire(runButton(host), "onClick", {}));
		const confirm = [...document.querySelectorAll("button")].find(
			button => button.textContent === translate("github.runs.dispatchConfirm"),
		);
		expect(confirm?.hasAttribute("disabled")).toBe(false);
		await act(async () => fire(document.querySelector("#github-dispatch"), "onSubmit", { preventDefault: () => {} }));
		expect(sent).toContainEqual({ repo: "o/r", op: "workflow_dispatch", workflow: "9" });
	});
});
