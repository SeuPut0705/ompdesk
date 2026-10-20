/**
 * The Preview check (preview-check.ts) through `gui_visualize open`: the judge path adds a notice and a hint, and
 * every other outcome (switch off, no native judge, "did not decide", an error, a timeout) leaves the tool's answer
 * exactly what it was without the check.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewCheckResult } from "../../../resources/gui-bridge/modes/judge-assist-contracts";
import {
	type CapturedImage,
	checkVisualPage,
	createTabCheck,
	judgeImage,
	PREVIEW_CHECK_CAPTURE_MS,
	PREVIEW_CHECK_IMAGE_MAX,
	PREVIEW_CHECK_PROBE_MS,
	PREVIEW_CHECK_TOTAL_MS,
	type PreviewCheckDeps,
	type PreviewImage,
	previewHint,
} from "./preview-check";
import { runVisualizeTool, type VisualPages, VisualStore } from "./visuals";

const IMAGE: PreviewImage = { data: "cG5n", mimeType: "image/png" };
const HINT_ERROR = "Preview check: the page shows an error message. Look at it with gui_visualize or fix the page.";
const HINT_BLANK =
	"Preview check: the page looks blank (nothing rendered). Look at it with gui_visualize or fix the page.";

let root: string;
let stores = 0;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-check-"));
});
afterEach(async () => {
	vi.useRealTimers();
	await fs.rm(root, { recursive: true, force: true });
});

const judgedAs = (problem: PreviewCheckResult["problem"]) =>
	vi.fn(async (): Promise<PreviewCheckResult> => ({ problem, judged: true }));

function fakeDeps(overrides: Partial<PreviewCheckDeps> = {}) {
	const flagged: Array<[string, number, string]> = [];
	const deps: PreviewCheckDeps = {
		enabled: () => true,
		available: async () => true,
		capture: vi.fn(async () => IMAGE),
		judge: vi.fn(async (): Promise<PreviewCheckResult | null> => ({ problem: null, judged: true })),
		flag: (id, version, problem) => flagged.push([id, version, problem]),
		...overrides,
	};
	return { deps, flagged };
}

/** What `gui_visualize open` answers for a fresh visual, the id masked; `check` is the context's (none = no check). */
async function open(check?: (id: string, version: number) => Promise<"error" | "blank" | null>) {
	const store = new VisualStore(path.join(root, `visuals-${++stores}`));
	const pages: VisualPages = {
		close: () => {},
		inspect: () => null,
		choose: async () => "none",
		capture: async () => null,
		flag: () => {},
	};
	const revealed: string[] = [];
	const result = await runVisualizeTool(
		{ tabId: "tab", cwd: root, store, pages, reveal: id => revealed.push(id), ...(check ? { check } : {}) },
		{ action: "open", html: "<p>hi</p>" },
	);
	const id = /visual ([0-9a-f]{16})/.exec(result.text)?.[1] ?? "";
	return { id, revealed, isError: result.isError, text: result.text.replace(id, "<id>") };
}

describe("Preview check on gui_visualize open", () => {
	it("tells the agent the page shows an error and flags that page", async () => {
		const { deps, flagged } = fakeDeps({ judge: judgedAs("error") });
		const withCheck = await open((id, version) => checkVisualPage(deps, id, version));
		const without = await open();
		expect(withCheck.text).toBe(`${without.text}\n${HINT_ERROR}`);
		expect(withCheck.isError).toBe(false);
		expect(flagged).toEqual([[withCheck.id, 1, "error"]]);
		expect(deps.capture).toHaveBeenCalledWith(withCheck.id, 1, PREVIEW_CHECK_CAPTURE_MS);
		expect(deps.judge).toHaveBeenCalledWith(IMAGE, expect.any(Number));
		// The page is shown first; the check follows it.
		expect(withCheck.revealed).toEqual([withCheck.id]);
	});

	it("tells the agent the page looks blank and flags that page", async () => {
		const { deps, flagged } = fakeDeps({ judge: judgedAs("blank") });
		const withCheck = await open((id, version) => checkVisualPage(deps, id, version));
		const without = await open();
		expect(withCheck.text).toBe(`${without.text}\n${HINT_BLANK}`);
		expect(flagged).toEqual([[withCheck.id, 1, "blank"]]);
	});

	const quiet: Array<[string, Partial<PreviewCheckDeps>]> = [
		["a page the judge finds fine", { judge: async () => ({ problem: null, judged: true }) }],
		["a judge that did not decide", { judge: async () => ({ problem: "error", judged: false }) }],
		["a failed judge request", { judge: async () => null }],
		[
			"a judge that throws",
			{
				judge: async () => {
					throw new Error("no key");
				},
			},
		],
		["a page that never showed", { capture: async () => null }],
		[
			"a capture that throws",
			{
				capture: async () => {
					throw new Error("destroyed");
				},
			},
		],
	];
	it.each(quiet)("answers exactly as before, with no notice, for %s", async (_name, overrides) => {
		const { deps, flagged } = fakeDeps(overrides);
		const withCheck = await open((id, version) => checkVisualPage(deps, id, version));
		const without = await open();
		expect(withCheck.text).toBe(without.text);
		expect(withCheck.isError).toBe(false);
		expect(flagged).toEqual([]);
	});

	it("captures nothing while the judgeAssist switch is off", async () => {
		const { deps, flagged } = fakeDeps({
			enabled: () => false,
			judge: judgedAs("error"),
		});
		const withCheck = await open((id, version) => checkVisualPage(deps, id, version));
		const without = await open();
		expect(withCheck.text).toBe(without.text);
		expect(deps.capture).not.toHaveBeenCalled();
		expect(deps.judge).not.toHaveBeenCalled();
		expect(flagged).toEqual([]);
	});

	it("gives up at the total bound with no verdict, and drops a verdict that comes later", async () => {
		vi.useFakeTimers();
		const late = Promise.withResolvers<PreviewCheckResult>();
		const { deps, flagged } = fakeDeps({ judge: () => late.promise });
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_TOTAL_MS - 1);
		expect(verdict).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(verdict).toBeNull();
		late.resolve({ problem: "error", judged: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(flagged).toEqual([]);
	});

	it("gives up on a page that never shows, and drops a picture that comes later", async () => {
		vi.useFakeTimers();
		const never = Promise.withResolvers<PreviewImage>();
		const { deps } = fakeDeps({ capture: () => never.promise });
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_TOTAL_MS);
		expect(verdict).toBeNull();
		never.resolve(IMAGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(deps.judge).not.toHaveBeenCalled();
	});

	it("gives the judge only what is left of the total bound", async () => {
		vi.useFakeTimers();
		const { deps } = fakeDeps({
			capture: async () => {
				await vi.advanceTimersByTimeAsync(1500);
				return IMAGE;
			},
		});
		await checkVisualPage(deps, "v", 1);
		expect(deps.judge).toHaveBeenCalledWith(IMAGE, PREVIEW_CHECK_TOTAL_MS - 1500);
	});
});

describe("previewHint", () => {
	it("names what the judge saw and what to do", () => {
		expect(previewHint("error")).toBe(HINT_ERROR);
		expect(previewHint("blank")).toBe(HINT_BLANK);
	});
});

describe("judge availability probe", () => {
	it("ends the check at once, with no capture and no waiting, when no native judge is there", async () => {
		vi.useFakeTimers();
		const { deps, flagged } = fakeDeps({ available: async () => false });
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(verdict).toBeNull();
		expect(deps.capture).not.toHaveBeenCalled();
		expect(deps.judge).not.toHaveBeenCalled();
		expect(flagged).toEqual([]);
	});

	it("ends the check at once when the probe throws", async () => {
		vi.useFakeTimers();
		const { deps } = fakeDeps({
			available: async () => {
				throw new Error("no bridge");
			},
		});
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(verdict).toBeNull();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("gives up on a probe that never answers after its short bound, not the whole check's", async () => {
		vi.useFakeTimers();
		const { deps } = fakeDeps({ available: () => new Promise<boolean>(() => {}) });
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_PROBE_MS - 1);
		expect(verdict).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(verdict).toBeNull();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("still checks when a busy omp answers the probe after a second, as a slow machine's does", async () => {
		vi.useFakeTimers();
		const { deps, flagged } = fakeDeps({
			available: () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 1200)),
			judge: judgedAs("error"),
		});
		let verdict: string | null | undefined;
		void checkVisualPage(deps, "v", 1).then(result => {
			verdict = result;
		});
		await vi.advanceTimersByTimeAsync(PREVIEW_CHECK_TOTAL_MS);
		expect(verdict).toBe("error");
		expect(flagged).toEqual([["v", 1, "error"]]);
	});

	it("asks the probe first, with its own bound, before the page is waited for", async () => {
		const order: string[] = [];
		const { deps } = fakeDeps({
			available: vi.fn(async () => {
				order.push("available");
				return true;
			}),
			capture: vi.fn(async () => {
				order.push("capture");
				return IMAGE;
			}),
		});
		await checkVisualPage(deps, "v", 1);
		expect(order).toEqual(["available", "capture"]);
		expect(deps.available).toHaveBeenCalledWith(PREVIEW_CHECK_PROBE_MS);
	});
});

describe("createTabCheck", () => {
	const AVAILABLE = { type: "response", command: "judge_available", success: true, data: { available: true } };
	/** The tab's omp: `probe` answers `judge_available`, `response` answers the judge request. */
	const tab = (response: unknown, probe: unknown = AVAILABLE) => {
		const command = vi.fn(async (request: { type: string }) =>
			request.type === "judge_available" ? probe : response,
		);
		const capture = vi.fn(async () => IMAGE);
		const flagged: string[] = [];
		const pages = {
			capture,
			flag: (_id: string, _version: number, problem: string) => flagged.push(problem),
		};
		return { command, capture, flagged, pages };
	};

	it("asks the tab's omp with the picture and reads its verdict", async () => {
		const { command, flagged, pages } = tab({
			type: "response",
			command: "judge_preview_check",
			success: true,
			data: { problem: "blank", judged: true },
		});
		const verdict = await createTabCheck({ enabled: () => true, pages, rpc: { command: command as never } })("v", 1);
		expect(verdict).toBe("blank");
		expect(command).toHaveBeenCalledWith({ type: "judge_preview_check", image: IMAGE }, expect.any(Number));
		expect(flagged).toEqual(["blank"]);
	});

	it.each([
		["a failed command", { type: "response", command: "judge_preview_check", success: false, error: "x" }],
		[
			"an answer that did not decide",
			{ type: "response", command: "judge_preview_check", success: true, data: { problem: null, judged: false } },
		],
		[
			"an unknown problem",
			{ type: "response", command: "judge_preview_check", success: true, data: { problem: "bad", judged: true } },
		],
		["no data", { type: "response", command: "judge_preview_check", success: true }],
	])("keeps today's behaviour for %s", async (_name, response) => {
		const { flagged, pages, command } = tab(response);
		expect(
			await createTabCheck({ enabled: () => true, pages, rpc: { command: command as never } })("v", 1),
		).toBeNull();
		expect(flagged).toEqual([]);
	});

	it("keeps today's behaviour while the tab's omp is not running", async () => {
		const { flagged, pages, capture } = tab(null);
		expect(await createTabCheck({ enabled: () => true, pages, rpc: null })("v", 1)).toBeNull();
		expect(capture).not.toHaveBeenCalled();
		expect(flagged).toEqual([]);
	});

	it.each([
		["no native judge", { type: "response", command: "judge_available", success: true, data: { available: false } }],
		["a failed probe", { type: "response", command: "judge_available", success: false, error: "x" }],
		["a probe with no data", { type: "response", command: "judge_available", success: true }],
		[
			"a probe that is not a boolean",
			{ type: "response", command: "judge_available", success: true, data: { available: "yes" } },
		],
	])("skips the whole check for %s: no capture, no judge request", async (_name, probe) => {
		const { command, capture, flagged, pages } = tab(
			{ type: "response", command: "judge_preview_check", success: true, data: { problem: "error", judged: true } },
			probe,
		);
		expect(
			await createTabCheck({ enabled: () => true, pages, rpc: { command: command as never } })("v", 1),
		).toBeNull();
		expect(capture).not.toHaveBeenCalled();
		expect(command.mock.calls.map(([request]) => request.type)).toEqual(["judge_available"]);
		expect(flagged).toEqual([]);
	});

	it("asks nothing while the switch is off, not even whether a judge exists", async () => {
		const { command, capture, pages } = tab(null);
		expect(
			await createTabCheck({ enabled: () => false, pages, rpc: { command: command as never } })("v", 1),
		).toBeNull();
		expect(command).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
	});

	it("asks whether a judge exists with the probe's short bound", async () => {
		const { command, pages } = tab(null);
		await createTabCheck({ enabled: () => true, pages, rpc: { command: command as never } })("v", 1);
		expect(command).toHaveBeenCalledWith({ type: "judge_available" }, PREVIEW_CHECK_PROBE_MS);
	});
});

describe("judgeImage", () => {
	const fake = (width: number, height: number, empty = false) => {
		const resized: Array<{ width: number; height: number }> = [];
		const image: CapturedImage = {
			isEmpty: () => empty,
			getSize: () => ({ width, height }),
			resize: options => {
				resized.push(options);
				return fake(options.width, options.height).image;
			},
			toPNG: () => Buffer.from(`${width}x${height}`),
		};
		return { image, resized };
	};

	it("keeps a picture that is small enough", () => {
		const { image, resized } = fake(1000, 700);
		expect(judgeImage(image)).toEqual({ data: Buffer.from("1000x700").toString("base64"), mimeType: "image/png" });
		expect(resized).toEqual([]);
	});

	it("scales the longer side down to the limit, keeping the proportions", () => {
		const wide = fake(2560, 1440);
		expect(judgeImage(wide.image)?.data).toBe(Buffer.from(`${PREVIEW_CHECK_IMAGE_MAX}x720`).toString("base64"));
		const tall = fake(1000, 4000);
		expect(judgeImage(tall.image)?.data).toBe(Buffer.from("320x1280").toString("base64"));
	});

	it("sends nothing for a capture with no pixels, which is no evidence of a blank page", () => {
		expect(judgeImage(fake(0, 0, true).image)).toBeNull();
	});
});
