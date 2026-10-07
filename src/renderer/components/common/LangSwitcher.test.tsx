/**
 * DOM test for the language switcher: it must show the current language
 * autonym and toggle the shared i18n context on click (EN → 한국어 → EN).
 * Harness mirrors ForkHandoffDialogs.test.tsx (linkedom + react-dom/client).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { LangSwitcher } from "./LangSwitcher";

const { document, window, Event, HTMLElement } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
}

let container: TestElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mountSwitcher(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<LangSwitcher />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
	}
	container?.remove();
	try {
		window.localStorage.removeItem("omp.lang");
	} catch {
		/* localStorage unavailable in the test env — getInitialLang falls back to en */
	}
});

describe("LangSwitcher", () => {
	it("shows the current language and toggles EN → 한국어 → EN on click", async () => {
		await mountSwitcher();
		const button = document.querySelector("button") as unknown as TestElement;
		expect(button.textContent).toContain("EN");

		await act(async () => {
			button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(button.textContent).toContain("한국어");

		await act(async () => {
			button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(button.textContent).toContain("EN");
	});

	it("falls back to the system language when the stored one is no longer shipped (omp.lang=zh)", async () => {
		const store: Record<string, string> = { "omp.lang": "zh" };
		globals.localStorage = {
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => {
				store[key] = value;
			},
			removeItem: (key: string) => {
				delete store[key];
			},
		};
		try {
			await mountSwitcher();
			expect(document.querySelector("button")?.textContent).toContain("EN");
		} finally {
			delete globals.localStorage;
		}
	});

	it("rehydrates a persisted Korean preference (omp.lang=ko → 한국어)", async () => {
		const store: Record<string, string> = { "omp.lang": "ko" };
		globals.localStorage = {
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => {
				store[key] = value;
			},
			removeItem: (key: string) => {
				delete store[key];
			},
		};
		try {
			await mountSwitcher();
			expect(document.querySelector("button")?.textContent).toContain("한국어");
		} finally {
			delete globals.localStorage;
		}
	});

	it("hydrates a main-process preference without overwriting it from the inferred renderer language", async () => {
		const store: Record<string, string> = {};
		const writes: Array<{ key: string; value: unknown }> = [];
		globals.localStorage = {
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => {
				store[key] = value;
			},
			removeItem: (key: string) => {
				delete store[key];
			},
		};
		const bridgeWindow = window as unknown as {
			omp?: {
				prefs: {
					get: (key: string) => Promise<unknown>;
					set: (key: string, value: unknown) => Promise<void>;
				};
			};
		};
		bridgeWindow.omp = {
			prefs: {
				get: async () => "ko",
				set: async (key, value) => {
					writes.push({ key, value });
				},
			},
		};
		try {
			await mountSwitcher();
			expect(document.querySelector("button")?.textContent).toContain("한국어");
			expect(writes).toEqual([]);
		} finally {
			delete bridgeWindow.omp;
			delete globals.localStorage;
		}
	});

	it("does not persist an inferred language when neither store has an explicit preference", async () => {
		const writes: Array<{ key: string; value: unknown }> = [];
		const bridgeWindow = window as unknown as {
			omp?: {
				prefs: {
					get: (key: string) => Promise<unknown>;
					set: (key: string, value: unknown) => Promise<void>;
				};
			};
		};
		bridgeWindow.omp = {
			prefs: {
				get: async () => undefined,
				set: async (key, value) => {
					writes.push({ key, value });
				},
			},
		};
		try {
			await mountSwitcher();
			expect(writes).toEqual([]);
		} finally {
			delete bridgeWindow.omp;
		}
	});
});
