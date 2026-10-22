import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { type ProviderCatalog, useProviderCatalog } from "./ProviderList";
import type { ProviderLogin } from "./ProviderLogin";
import { ProviderPicker } from "./ProviderPicker";

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
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

function row(id: string, name: string, partial: Partial<ProviderInfo> = {}): ProviderInfo {
	return { id, name, authenticated: false, loginAvailable: true, disabled: false, modelCount: 0, ...partial };
}

// Stock's own names, in the catalog's (company) order rather than the featured order.
const stock = [
	row("anthropic", "Anthropic (Claude Pro/Max)"),
	row("deepseek", "DeepSeek"),
	row("google-gemini-cli", "Google Cloud Code Assist (Gemini CLI)"),
	row("groq", "Groq"),
	row("openai-codex", "ChatGPT Plus/Pro (Codex Subscription)"),
	row("openrouter", "OpenRouter"),
	row("xai", "xAI API"),
	row("xai-oauth", "xAI Grok OAuth (SuperGrok or X Premium+)"),
];

function catalogOf(providers: ProviderInfo[]): ProviderCatalog {
	return {
		providers,
		customConfigs: [],
		options: null,
		loading: false,
		error: null,
		configError: null,
		refreshPending: false,
		sidecarReady: true,
		loginReady: true,
		load: vi.fn(),
	} as unknown as ProviderCatalog;
}

function fakeLogin(): ProviderLogin & { start: ReturnType<typeof vi.fn> } {
	return {
		state: { providerId: null, running: false },
		start: vi.fn(async () => true),
		submit: vi.fn(),
		cancel: vi.fn(),
	} as unknown as ProviderLogin & { start: ReturnType<typeof vi.fn> };
}

const roots: Root[] = [];
async function mount(
	providers: ProviderInfo[],
	login: ProviderLogin,
	showConnectedFeatured = false,
	headingLevel?: 2 | 4,
) {
	const root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<ProviderPicker
					catalog={catalogOf(providers)}
					headingLevel={headingLevel}
					login={login}
					showConnectedFeatured={showConnectedFeatured}
				/>
			</I18nProvider>,
		),
	);
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
});

const featuredIds = () =>
	Array.from(document.querySelectorAll("[data-featured-provider]")).map(
		item => item.getAttribute("data-featured-provider") ?? "",
	);
const otherIds = () =>
	Array.from(document.querySelectorAll("[data-provider-picker] [data-provider-connect]")).map(
		item => item.getAttribute("data-provider-connect") ?? "",
	);

describe("ProviderPicker featured group", () => {
	it("puts ChatGPT, Claude, OpenRouter, Google and Grok first, everything else under Other providers", async () => {
		await mount(stock, fakeLogin());
		expect(featuredIds()).toEqual(["openai-codex", "anthropic", "openrouter", "google-gemini-cli", "xai-oauth"]);
		const names = Array.from(document.querySelectorAll("[data-featured-provider] > button:first-child"));
		expect(names.map(item => item.textContent)).toEqual([
			`ChatGPT (Plus/Pro)${translate("providers.featured.subscription")}${translate("providers.featured.signIn")}`,
			`Claude (Pro/Max)${translate("providers.featured.subscription")}${translate("providers.featured.signIn")}`,
			`OpenRouter${translate("providers.featured.apiKey")}${translate("providers.featured.connect")}`,
			`Google (Gemini)${translate("providers.featured.subscription")}${translate("providers.featured.signIn")}`,
			`Grok (SuperGrok)${translate("providers.featured.subscription")}${translate("providers.featured.signIn")}`,
		]);
		// Each card carries the brand mark.
		expect(document.querySelectorAll("[data-featured-provider] [data-provider-mark]").length).toBe(5);
		expect(otherIds()).toEqual(["deepseek", "groq"]);
		expect(document.body.textContent).toContain(translate("providers.other.title"));
		// The featured group sits above the others in the document.
		const group = document.querySelector("[data-featured-providers]");
		const rest = document.querySelector("[data-provider-picker]");
		expect(group && rest && group.compareDocumentPosition(rest) & 4).toBeTruthy();
	});

	it("names its groups one level under the heading that holds it: h4 in a Settings section, h2 on first run", async () => {
		await mount(stock, fakeLogin());
		const levels = () => Array.from(document.querySelectorAll("h2, h3, h4")).map(heading => heading.tagName);
		expect(levels()).toEqual(["H4", "H4"]);
		for (const root of roots) await act(async () => root.unmount());
		roots.length = 0;
		await mount(stock, fakeLogin(), true, 2);
		expect(levels()).toEqual(["H2", "H2"]);
	});

	it("starts stock's own login per action: subscription OAuth first, Grok's API key second", async () => {
		const login = fakeLogin();
		await mount(stock, login);
		const click = (selector: string) =>
			act(async () => (document.querySelector(selector) as unknown as HTMLButtonElement).click());
		await click('[data-featured-provider="openai-codex"] button');
		await click('[data-featured-provider="anthropic"] button');
		await click('[data-featured-provider="openrouter"] button');
		await click('[data-featured-provider="google-gemini-cli"] button');
		await click('[data-featured-provider="xai-oauth"] button');
		await click('[data-featured-provider="xai-oauth"] button[data-provider-connect="xai"]');
		expect(login.start.mock.calls.map(call => call[0])).toEqual([
			"openai-codex",
			"anthropic",
			"openrouter",
			"google-gemini-cli",
			"xai-oauth",
			"xai",
		]);
		// Only Grok has both logins, so only Grok has a second action.
		expect(document.querySelectorAll("[data-featured-provider] button").length).toBe(6);
		// The API-key action lives inside Grok's own card, not beside it.
		const grok = document.querySelector('[data-featured-provider="xai-oauth"]');
		expect(grok?.querySelectorAll("button").length).toBe(2);
		expect(grok?.querySelector('button[data-provider-connect="xai"]')?.textContent).toBe(
			translate("providers.featured.apiKeyAction"),
		);
		expect(document.querySelectorAll('[data-featured-provider] button[data-provider-connect="xai"]').length).toBe(1);
	});

	it("shows a connected featured provider as connected on first run and leaves it out of Settings' picker", async () => {
		const connected = stock.map(item => (item.id === "anthropic" ? { ...item, authenticated: true } : item));
		await mount(connected, fakeLogin(), true);
		expect(featuredIds()).toContain("anthropic");
		const card = document.querySelector('[data-provider-connected="anthropic"]');
		expect(card?.textContent).toContain(translate("providerList.connected"));
		expect(document.querySelector('button[data-provider-connect="anthropic"]')).toBeNull();
		for (const root of roots.splice(0)) await act(async () => root.unmount());
		while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		await mount(connected, fakeLogin(), false);
		expect(featuredIds()).toEqual(["openai-codex", "openrouter", "google-gemini-cli", "xai-oauth"]);
	});

	it("is a flat search result without the group while searching", async () => {
		await mount(stock, fakeLogin());
		const input = document.querySelector('input[type="search"]') as unknown as Record<string, unknown>;
		input.value = "anthropic";
		const propsKey = Object.getOwnPropertyNames(input).find(key => key.startsWith("__reactProps$"));
		const props = input[propsKey ?? ""] as { onChange?: (event: object) => void };
		await act(async () => props.onChange?.({ target: input, currentTarget: input }));
		expect(document.querySelector("[data-featured-providers]")).toBeNull();
		expect(otherIds()).toEqual(["anthropic"]);
	});
});

describe("ProviderPicker while omp starts", () => {
	function LivePicker({ login }: { login: ProviderLogin }) {
		const catalog = useProviderCatalog({ active: false });
		return <ProviderPicker catalog={catalog} login={login} />;
	}

	async function mountLive(status: "starting" | "error", login: ProviderLogin) {
		useModelStore.setState({ providers: stock });
		useSessionStore.getState().setStatus(status, "/tmp/project");
		const root = createRoot(document.body as unknown as Element);
		await act(async () =>
			root.render(
				<I18nProvider>
					<LivePicker login={login} />
				</I18nProvider>,
			),
		);
		roots.push(root);
	}

	const claudeCard = () => document.querySelector<HTMLButtonElement>('[data-featured-provider="anthropic"] button');

	it("lets a card start a sign-in while the session is starting, held until omp is ready", async () => {
		const login = fakeLogin();
		await mountLive("starting", login);
		expect(claudeCard()?.disabled).toBe(false);
		expect(claudeCard()?.getAttribute("title")).toBeNull();
		await act(async () => claudeCard()?.click());
		expect(login.start).toHaveBeenCalledWith("anthropic");
	});

	it("keeps the cards disabled, saying why, when the session failed", async () => {
		const login = fakeLogin();
		await mountLive("error", login);
		expect(claudeCard()?.disabled).toBe(true);
		expect(claudeCard()?.getAttribute("title")).toBe(translate("providers.notConnected"));
		await act(async () => claudeCard()?.click());
		expect(login.start).not.toHaveBeenCalled();
	});
});
