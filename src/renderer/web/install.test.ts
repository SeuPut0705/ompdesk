import { describe, expect, it, vi } from "vitest";
import {
	type BeforeInstallPromptEvent,
	type InstallEnvironment,
	InstallPrompt,
	installGuidance,
	installHintDue,
	installOffered,
	installPlatform,
	installStepKeys,
} from "./install";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari";
const SAMSUNG =
	"Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121 Mobile Safari/537.36";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0";
const FIREFOX_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15";

function env(overrides: Partial<InstallEnvironment>): InstallEnvironment {
	return { userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0, standalone: false, ...overrides };
}

describe("installPlatform", () => {
	it("tells iPhone, iPadOS (a touch-screen Mac), Android and the rest apart", () => {
		expect(installPlatform(env({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }))).toBe("ios");
		expect(installPlatform(env({ maxTouchPoints: 5 }))).toBe("ios");
		expect(installPlatform(env({ userAgent: ANDROID, platform: "Linux armv81", maxTouchPoints: 5 }))).toBe("android");
		expect(installPlatform(env({}))).toBe("other");
	});
});

describe("installGuidance", () => {
	const iphone = env({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 });
	const android = env({ userAgent: ANDROID, platform: "Linux armv81" });
	const samsung = env({ userAgent: SAMSUNG, platform: "Linux armv81" });
	const firefox = env({ userAgent: FIREFOX_ANDROID, platform: "Linux armv81" });
	const idle = { promptAvailable: false };

	it("shows the Add to Home Screen steps on iOS in a tab, nothing once installed", () => {
		expect(installGuidance(iphone, idle)).toBe("ios-share");
		expect(installGuidance({ ...iphone, standalone: true }, idle)).toBe("installed");
	});

	it("offers the install prompt only when the browser fired one", () => {
		expect(installGuidance(android, idle)).toBe("none");
		expect(installGuidance(android, { promptAvailable: true })).toBe("prompt");
		expect(installGuidance(env({}), { promptAvailable: true })).toBe("prompt");
	});

	it("gives Samsung Internet and Firefox on Android their menu steps, and a prompt wins over them", () => {
		expect(installGuidance(samsung, idle)).toBe("samsung-menu");
		expect(installGuidance(firefox, idle)).toBe("firefox-menu");
		expect(installGuidance(samsung, { promptAvailable: true })).toBe("prompt");
		// Desktop Firefox cannot install a page: nothing to say.
		expect(installGuidance(env({ userAgent: FIREFOX_DESKTOP }), idle)).toBe("none");
	});

	it("hides every offer when running standalone or once installed from this tab", () => {
		for (const device of [android, samsung, firefox, iphone, env({})]) {
			expect(installGuidance({ ...device, standalone: true }, { promptAvailable: true })).toBe("installed");
			expect(installGuidance(device, { promptAvailable: true, installed: true })).toBe("installed");
		}
		expect(installOffered("installed")).toBe(false);
		expect(installOffered("none")).toBe(false);
		expect(installOffered("prompt")).toBe(true);
	});

	it("has numbered steps for the menu-based guidance only", () => {
		expect(installStepKeys("ios-share")).toHaveLength(3);
		expect(installStepKeys("samsung-menu")).toHaveLength(3);
		expect(installStepKeys("firefox-menu")).toHaveLength(3);
		expect(installStepKeys("prompt")).toEqual([]);
		expect(installStepKeys("installed")).toEqual([]);
	});
});

describe("installHintDue", () => {
	it("is due from the second visit, once, and only where there is something to offer", () => {
		expect(installHintDue({ visits: 1, shown: false }, "prompt")).toBe(false);
		expect(installHintDue({ visits: 2, shown: false }, "prompt")).toBe(true);
		expect(installHintDue({ visits: 5, shown: false }, "ios-share")).toBe(true);
		expect(installHintDue({ visits: 2, shown: true }, "prompt")).toBe(false);
		expect(installHintDue({ visits: 2, shown: false }, "installed")).toBe(false);
		expect(installHintDue({ visits: 2, shown: false }, "none")).toBe(false);
	});
});

class FakeTarget {
	readonly listeners = new Map<string, (event: Event) => void>();
	addEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.set(type, listener);
	}
	fire(type: string, event: Event): void {
		this.listeners.get(type)?.(event);
	}
}

function promptEvent(outcome: "accepted" | "dismissed") {
	const prompt = vi.fn(async () => undefined);
	const preventDefault = vi.fn();
	const event = {
		prompt,
		preventDefault,
		userChoice: Promise.resolve({ outcome }),
	} as unknown as BeforeInstallPromptEvent;
	return { event, prompt, preventDefault };
}

describe("InstallPrompt", () => {
	it("keeps the event, replaces the browser's mini-bar and uses it once", async () => {
		const target = new FakeTarget();
		const prompt = new InstallPrompt(target);
		const changed = vi.fn();
		prompt.onChange(changed);
		expect(prompt.available).toBe(false);
		expect(await prompt.install()).toBe("unavailable");

		const fired = promptEvent("accepted");
		target.fire("beforeinstallprompt", fired.event);
		expect(fired.preventDefault).toHaveBeenCalled();
		expect(prompt.available).toBe(true);
		expect(await prompt.install()).toBe("accepted");
		expect(fired.prompt).toHaveBeenCalledTimes(1);
		expect(prompt.available).toBe(false);
		expect(await prompt.install()).toBe("unavailable");
		expect(changed).toHaveBeenCalled();
	});

	it("forgets the prompt when the app gets installed", () => {
		const target = new FakeTarget();
		const prompt = new InstallPrompt(target);
		target.fire("beforeinstallprompt", promptEvent("dismissed").event);
		target.fire("appinstalled", new Event("appinstalled"));
		expect(prompt.available).toBe(false);
	});
});
