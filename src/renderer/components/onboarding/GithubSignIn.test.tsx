/**
 * GitHub sign-in card: signed out offers "Sign in with GitHub"; the device code
 * shows with a copy control, and "Copy code & open GitHub" copies, opens the
 * device page and only then releases gh; signed in shows the commit identity,
 * sign-out and account switching; a missing CLI never offers a sign-in.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthState } from "../../../shared/github-auth";
import { I18nProvider, translate } from "../../lib/i18n";
import { useGithubAuthStore } from "../../stores/github-auth";
import { fakeGithubAuth, githubState } from "../../test-support/github-auth";
import { GithubSignIn } from "./GithubSignIn";

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

const fake = fakeGithubAuth();
const openExternal = vi.fn(async () => {});
const writeText = vi.fn(async (_text: string) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { githubAuth: fake.api, system: { openExternal } },
});
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true });

let root: Root | null = null;
async function mount(state: GithubAuthState, onSignedIn?: () => void): Promise<void> {
	fake.set(state);
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<GithubSignIn onSignedIn={onSignedIn} />
			</I18nProvider>,
		),
	);
}

const text = () => document.body.textContent ?? "";
const button = (name: string) =>
	Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name || candidate.getAttribute("aria-label") === name,
	) as HTMLButtonElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	useGithubAuthStore.getState().reset();
	for (const fn of Object.values(fake.api)) fn.mockClear();
	openExternal.mockClear();
	writeText.mockClear();
});

describe("GithubSignIn", () => {
	it("starts a sign-in from the signed-out state", async () => {
		await mount(githubState());
		expect(fake.api.refresh).toHaveBeenCalledWith(false);
		expect(text()).toContain(translate("githubAuth.badge.signedOut"));
		expect(text()).toContain("gh 2.62.0");
		await act(async () => button(translate("githubAuth.signIn"))?.click());
		expect(fake.api.startLogin).toHaveBeenCalledOnce();
	});

	it("copies the code and opens GitHub before gh is released, then waits for the approval", async () => {
		const flow = { state: "code" as const, code: "ABCD-1234", url: "https://github.com/login/device", opened: false };
		await mount(githubState({ flow }));
		expect(document.querySelector('[data-testid="github-device-code"]')?.textContent).toContain("ABCD-1234");
		expect(text()).toContain(translate("githubAuth.code.instructions"));
		expect(text()).not.toContain(translate("githubAuth.code.waiting"));
		fake.set(githubState({ flow: { ...flow, opened: true } }));
		await act(async () => button(translate("githubAuth.code.open"))?.click());
		expect(writeText).toHaveBeenCalledWith("ABCD-1234");
		expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
		expect(fake.api.openLogin).toHaveBeenCalledOnce();
		expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(fake.api.openLogin.mock.invocationCallOrder[0]);
		expect(text()).toContain(translate("githubAuth.code.waiting"));
		expect(button(translate("githubAuth.code.reopen"))).toBeDefined();

		await act(async () => button(translate("common.cancel"))?.click());
		expect(fake.api.cancelLogin).toHaveBeenCalledOnce();
	});

	it("shows the identity, signs out, switches accounts and reports a sign-in that just completed", async () => {
		const onSignedIn = vi.fn();
		await mount(githubState(), onSignedIn);
		expect(onSignedIn).not.toHaveBeenCalled();
		await act(async () =>
			fake.push(
				githubState({
					status: {
						installed: true,
						version: "2.62.0",
						authenticated: true,
						login: "octocat",
						otherAccounts: ["hubot"],
					},
					identity: { name: "The Octocat", email: "octocat@github.com" },
					identityFilled: ["name", "email"],
					flow: { state: "success", login: "octocat" },
				}),
			),
		);
		expect(onSignedIn).toHaveBeenCalledOnce();
		expect(text()).toContain("octocat");
		expect(document.querySelector('[data-testid="github-identity"]')?.textContent).toContain(
			translate("githubAuth.identity.commitsAs", { name: "The Octocat", email: "octocat@github.com" }),
		);
		expect(text()).toContain(translate("githubAuth.identity.filled"));

		await act(async () => button(translate("githubAuth.switch"))?.click());
		const hubot = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
			item => item.textContent?.trim() === "hubot",
		) as HTMLElement | undefined;
		await act(async () => hubot?.click());
		expect(fake.api.switchAccount).toHaveBeenCalledWith("hubot");

		await act(async () => button(translate("githubAuth.signOut"))?.click());
		expect(fake.api.logout).toHaveBeenCalledOnce();
	});

	it("offers to fill an empty Git identity for an account signed in elsewhere", async () => {
		await mount(
			githubState({
				status: { installed: true, version: "2.62.0", authenticated: true, login: "octocat", otherAccounts: [] },
				identity: { name: "Someone", email: null },
			}),
		);
		expect(text()).toContain(translate("githubAuth.identity.missing"));
		await act(async () => button(translate("githubAuth.identity.fill"))?.click());
		expect(fake.api.fillIdentity).toHaveBeenCalledOnce();
	});

	it("never offers a sign-in without the GitHub CLI, and words a failed sign-in", async () => {
		await mount(
			githubState({
				status: { installed: false, version: null, authenticated: false, login: null, otherAccounts: [] },
			}),
		);
		expect(text()).toContain(translate("githubAuth.missing.title"));
		expect(button(translate("githubAuth.signIn"))).toBeUndefined();
		await act(async () => fake.push(githubState({ flow: { state: "failed", reason: "timeout" } })));
		expect(text()).toContain(translate("githubAuth.failed.timeout"));
		expect(button(translate("common.retry"))).toBeDefined();
	});
});
