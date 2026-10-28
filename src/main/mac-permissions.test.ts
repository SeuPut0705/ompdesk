import { describe, expect, it, vi } from "vitest";
import { askMacPermissionsOnce, MAC_PERMISSIONS_ASKED_PREF, type MacPermissionDeps } from "./mac-permissions";

function setup(overrides: Partial<MacPermissionDeps> = {}, stored: Record<string, unknown> = {}) {
	const data = { ...stored };
	const accessibilityTrusted = vi.fn(() => false);
	const requestScreenCapture = vi.fn(async () => {});
	const deps: MacPermissionDeps = {
		platform: "darwin",
		automatic: true,
		prefs: {
			get: key => data[key],
			set: (key, value) => {
				data[key] = value;
			},
		},
		accessibilityTrusted,
		screenStatus: () => "not-determined",
		requestScreenCapture,
		...overrides,
	};
	return { deps, data, accessibilityTrusted, requestScreenCapture };
}

describe("askMacPermissionsOnce", () => {
	it("asks the OS for Accessibility and Screen Recording at the first launch, and never again", async () => {
		const { deps, data, accessibilityTrusted, requestScreenCapture } = setup();
		expect(await askMacPermissionsOnce(deps)).toBe(true);
		expect(accessibilityTrusted).toHaveBeenCalledWith(true);
		expect(requestScreenCapture).toHaveBeenCalledTimes(1);
		expect(data[MAC_PERMISSIONS_ASKED_PREF]).toBe(true);

		// A declined or ignored prompt is remembered: the next launch asks nothing.
		expect(await askMacPermissionsOnce(deps)).toBe(false);
		expect(accessibilityTrusted).toHaveBeenCalledTimes(1);
		expect(requestScreenCapture).toHaveBeenCalledTimes(1);
	});

	it("remembers the ask before the prompts show, so a crash in them does not repeat it", async () => {
		const { deps, data } = setup({
			accessibilityTrusted: () => {
				throw new Error("boom");
			},
		});
		await expect(askMacPermissionsOnce(deps)).rejects.toThrow("boom");
		expect(data[MAC_PERMISSIONS_ASKED_PREF]).toBe(true);
	});

	it("skips Screen Recording when the person already answered it", async () => {
		const { deps, requestScreenCapture } = setup({ screenStatus: () => "denied" });
		expect(await askMacPermissionsOnce(deps)).toBe(true);
		expect(requestScreenCapture).not.toHaveBeenCalled();
	});

	it("asks nothing off macOS or outside a packaged, non-headless app", async () => {
		for (const overrides of [{ platform: "win32" as const }, { platform: "linux" as const }, { automatic: false }]) {
			const { deps, data, accessibilityTrusted } = setup(overrides);
			expect(await askMacPermissionsOnce(deps)).toBe(false);
			expect(accessibilityTrusted).not.toHaveBeenCalled();
			expect(data[MAC_PERMISSIONS_ASKED_PREF]).toBeUndefined();
		}
	});
});
