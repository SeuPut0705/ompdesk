import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RpcOmpUpdateResult } from "../../../shared/rpc-types";
import { UpdateFailureLines, UpdateProgress, updateOverviewState } from "./UpdatesSection";

const CURRENT_CORE: RpcOmpUpdateResult = {
	currentVersion: "17.2.10",
	latestVersion: "17.2.10",
	updateAvailable: false,
	checkedAt: "2026-08-10T00:00:00.000Z",
	distribution: "system",
	installStrategy: "omp-update",
};

describe("updates overview state", () => {
	it("does not claim the system is healthy before both checks finish", () => {
		expect(updateOverviewState({ state: "idle" }, undefined, undefined, false)).toBe("checking");
		expect(updateOverviewState({ state: "checking" }, CURRENT_CORE, undefined, true)).toBe("checking");
		expect(updateOverviewState({ state: "error", message: "stale" }, CURRENT_CORE, "stale", true)).toBe("checking");
	});

	it("surfaces updater and core failures instead of rendering up to date", () => {
		expect(updateOverviewState({ state: "error", message: "offline" }, CURRENT_CORE, undefined, false)).toBe("error");
		expect(updateOverviewState({ state: "not-available", version: "0.7.1" }, undefined, "offline", false)).toBe(
			"error",
		);
	});

	it("reports attention when either deliverable has an update", () => {
		expect(
			updateOverviewState({ state: "available", version: "0.7.2", mode: "manual" }, CURRENT_CORE, undefined, false),
		).toBe("attention");
		expect(
			updateOverviewState(
				{ state: "not-available", version: "0.7.1" },
				{ ...CURRENT_CORE, latestVersion: "17.2.12", updateAvailable: true },
				undefined,
				false,
			),
		).toBe("attention");
	});

	it("asks for GitHub access instead of reporting healthy or failed", () => {
		expect(updateOverviewState({ state: "auth-required", reason: "missing" }, CURRENT_CORE, undefined, false)).toBe(
			"attention",
		);
	});

	it("reports healthy only after both checks explicitly succeed", () => {
		expect(updateOverviewState({ state: "not-available", version: "0.7.1" }, CURRENT_CORE, undefined, false)).toBe(
			"healthy",
		);
	});
});

describe("UpdateFailureLines", () => {
	it("reads the localized sentences as text and keeps only the raw causes in the code-styled detail", () => {
		const html = renderToStaticMarkup(
			createElement(UpdateFailureLines, {
				app: { state: "error", message: "Couldn't finish the update check.", detail: "net::ERR_TIMED_OUT" },
				core: { message: "Couldn't check omp.", cause: "omp update --check exited 1" },
			}),
		);
		const root = parseHTML(`<div id="root">${html}</div>`).document.getElementById("root");
		const details = [...(root?.querySelectorAll("[data-error-detail]") ?? [])].map(node => node.textContent);
		expect(details).toEqual(["net::ERR_TIMED_OUT", "omp update --check exited 1"]);
		expect(root?.textContent).toContain("Couldn't finish the update check.");
		expect(root?.textContent).toContain("omp: Couldn't check omp.");
	});
});

describe("UpdateProgress", () => {
	const bar = (props: { percent?: number; label: string }) =>
		parseHTML(
			`<div id="root">${renderToStaticMarkup(createElement(UpdateProgress, props))}</div>`,
		).document.querySelector('[role="progressbar"]');

	it("shows the app download as a determinate accent bar with its percent", () => {
		const node = bar({ percent: 42, label: "Downloading" });
		expect(node?.getAttribute("aria-valuenow")).toBe("0.42");
		expect(node?.getAttribute("aria-label")).toBe("Downloading");
		expect(node?.parentElement?.textContent).toContain("42%");
		expect(node?.innerHTML).toContain("var(--sc-accent)");
	});

	it("shows the omp update as an indeterminate bar that claims no fraction", () => {
		const node = bar({ label: "Updating omp" });
		expect(node?.hasAttribute("aria-valuenow")).toBe(false);
		expect(node?.querySelector(".omp-indeterminate-progress")).toBeTruthy();
	});
});
