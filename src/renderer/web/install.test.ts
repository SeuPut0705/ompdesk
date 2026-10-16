import { describe, expect, it, vi } from "vitest";
import {
	type BeforeInstallPromptEvent,
	type InstallEnvironment,
	InstallPrompt,
	installGuidance,
	installPlatform,
} from "./install";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari";
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
	it("shows the Add to Home Screen steps on iOS in a tab, nothing once installed", () => {
		const iphone = env({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 });
		expect(installGuidance(iphone, false)).toBe("ios-share");
		expect(installGuidance({ ...iphone, standalone: true }, false)).toBe("installed");
	});

	it("offers the install prompt only when the browser fired one", () => {
		const android = env({ userAgent: ANDROID, platform: "Linux armv81" });
		expect(installGuidance(android, false)).toBe("none");
		expect(installGuidance(android, true)).toBe("prompt");
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
