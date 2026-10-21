/**
 * Contract test for the tool-result unwrapper (TUI-parity P0.1/P0.2). The same
 * tool result reaches renderers as a live `AgentToolResult` envelope
 * `{content:[{type:"text",text}], details:{…}}` or as hydrated history (same
 * envelope, details now preserved). Renderers must see body text + structured
 * details — never the raw JSON of the envelope itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractImageDataUrl,
	extractImageDataUrls,
	formatElapsed,
	formatShortClock,
	formatSpan,
	formatSpanCompact,
	formatTimeAgo,
	formatTokens,
	resultDetails,
	resultText,
	sanitizeToolText,
	uiLocale,
} from "./format";

describe("formatElapsed", () => {
	it("shows nothing before the first second, then whole seconds and minutes", () => {
		expect([0, 810, -50, Number.NaN].map(formatElapsed)).toEqual(["", "", "", ""]);
		expect([1000, 1999, 59_999, 60_000, 125_400].map(formatElapsed)).toEqual(["1s", "1s", "59s", "1m 0s", "2m 5s"]);
		expect([3_599_999, 3_600_000, 5_430_000].map(formatElapsed)).toEqual(["59m 59s", "1h 0m", "1h 30m"]);
	});
});

describe("formatSpan", () => {
	it("names a reset or an age in its two largest units, never as thousands of minutes", () => {
		const minute = 60_000;
		const hour = 60 * minute;
		expect(
			[
				-5,
				0,
				42_900,
				minute,
				59 * minute + 59_000,
				hour,
				4 * hour + 31 * minute,
				24 * hour,
				6 * 24 * hour + 23 * hour + 59 * minute,
			].map(formatSpan),
		).toEqual(["0s", "0s", "42s", "1m", "59m", "1h 0m", "4h 31m", "1d 0h", "6d 23h"]);
	});
});

describe("formatSpanCompact", () => {
	it("keeps at most two English units and drops a zero second one", () => {
		const minute = 60_000;
		const hour = 60 * minute;
		expect(
			[
				-5,
				42_900,
				4 * minute,
				59 * minute + 59_000,
				hour,
				hour + 54 * minute,
				24 * hour,
				4 * 24 * hour + hour + 3 * minute,
			].map(formatSpanCompact),
		).toEqual(["0s", "42s", "4m", "59m", "1h", "1h 54m", "1d", "4d 1h"]);
	});
});

it("never rounds a relative age down to zero minutes", () => {
	vi.useFakeTimers();
	try {
		const now = Date.parse("2026-10-13T00:00:00Z");
		vi.setSystemTime(now);
		expect([0, 44_000, 45_000, 59_999].map(age => formatTimeAgo(new Date(now - age).toISOString()))).toEqual([
			"just now",
			"just now",
			"just now",
			"just now",
		]);
		expect(formatTimeAgo(new Date(now - 60_000).toISOString())).toBe("1m");
		// Epoch ms reads the same as its ISO time; a time it cannot read is no age.
		expect(formatTimeAgo(now - 3 * 3_600_000)).toBe("3h");
		expect(formatTimeAgo("not a time")).toBe("");
	} finally {
		vi.useRealTimers();
	}
});

describe("UI-language dates", () => {
	const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;
	afterEach(() => {
		(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
	});

	it("formats dates in Korean when the UI is Korean and the OS locale is English", () => {
		expect(navigator.language).toBe("en-US");
		(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (key === "omp.lang" ? "ko" : null),
			setItem: () => {},
		};
		expect(uiLocale()).toBe("ko-KR");
		expect(formatTimeAgo("2026-08-08T12:00:00Z")).toBe("8월 8일");
	});
});

describe("formatShortClock", () => {
	it("keeps timeline labels to hour and minute", () => {
		const label = formatShortClock("2026-08-08T10:42:37+08:00");
		expect(label).toMatch(/^\d{2}:\d{2}$/);
		expect(label).not.toContain("2026");
	});
});

const liveEnvelope = {
	content: [
		{ type: "text", text: "hello output" },
		{ type: "image", data: "base64…", mimeType: "image/png" },
	],
	details: { exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] },
};

describe("resultText envelope unwrap", () => {
	it("unwraps the live {content,details} envelope to body text, not JSON", () => {
		expect(resultText(liveEnvelope)).toBe("hello output");
		expect(resultText(liveEnvelope)).not.toContain('"details"');
	});

	it("skips non-text content blocks (image) instead of JSON-stringifying them", () => {
		expect(
			resultText({
				content: [
					{ type: "image", data: "x" },
					{ type: "text", text: "cap" },
				],
			}),
		).toBe("cap");
	});

	it("handles a bare hydrated content array", () => {
		expect(
			resultText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});

	it("still handles plain strings / stdout envelopes", () => {
		expect(resultText("plain")).toBe("plain");
		expect(resultText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
	});
});

describe("resultDetails", () => {
	it("returns the details object from a live envelope", () => {
		expect(resultDetails(liveEnvelope)).toEqual({ exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] });
	});

	it("returns undefined for a bare content array or non-object", () => {
		expect(resultDetails([{ type: "text", text: "a" }])).toBeUndefined();
		expect(resultDetails("str")).toBeUndefined();
		expect(resultDetails(null)).toBeUndefined();
	});
});

describe("image result extraction", () => {
	it("collects multi-image result details without widening the legacy single-image lookup", () => {
		const result = {
			content: [{ type: "text", text: "output" }],
			details: {
				images: [
					{ type: "image", data: "first", mimeType: "image/png" },
					{ type: "image", data: "second", mimeType: "image/jpeg" },
				],
			},
		};

		expect(extractImageDataUrls(result)).toEqual(["data:image/png;base64,first", "data:image/jpeg;base64,second"]);
		expect(extractImageDataUrl(result)).toBeNull();
	});

	it("reads generate_image's untagged {data, mimeType} pairs as pictures", () => {
		// Not content blocks — `generate_image` reports the raw bytes it got back,
		// so a renderer that only understands `{type: "image"}` shows no preview.
		const result = {
			content: [{ type: "text", text: "Provider: openai\nModel: gpt-image-1\nGenerated 2 image(s):" }],
			details: {
				provider: "openai",
				imageCount: 2,
				imagePaths: ["/tmp/omp-image-1.png", "/tmp/omp-image-2.jpg"],
				images: [
					{ data: "first", mimeType: "image/png" },
					{ data: "second", mimeType: "image/jpeg" },
				],
			},
		};

		expect(extractImageDataUrls(result)).toEqual(["data:image/png;base64,first", "data:image/jpeg;base64,second"]);
	});
});

describe("sanitizeToolText", () => {
	it("strips ANSI SGR color codes down to visible text", () => {
		expect(sanitizeToolText("\x1b[31mred\x1b[0m plain")).toBe("red plain");
	});

	it("expands tabs to four spaces so they never punch holes in the layout", () => {
		expect(sanitizeToolText("a\tb")).toBe("a    b");
	});

	it("strips an OSC-8 hyperlink escape but keeps its anchor text", () => {
		expect(sanitizeToolText("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
	});

	it("handles color and tabs together", () => {
		expect(sanitizeToolText("\x1b[1m\x1b[32mgreen\ttab\x1b[0m")).toBe("green    tab");
	});
});

describe("formatTokens trimZero", () => {
	it("keeps existing output and only drops a trailing .0 on request", () => {
		expect(formatTokens(850_000)).toBe("850.0k");
		expect(formatTokens(850_000, { trimZero: true })).toBe("850k");
		expect(formatTokens(12_300, { trimZero: true })).toBe("12.3k");
		expect(formatTokens(2_000_000, { trimZero: true })).toBe("2M");
		expect(formatTokens(950, { trimZero: true })).toBe("950");
	});
});
