/**
 * GitHub sign-in card: signed out offers "Sign in with GitHub"; the device code
 * shows with a copy control, and "Copy code & open GitHub" copies, opens the
 * device page and only then releases gh; signed in shows the commit identity,
 * sign-out and account switching. A missing CLI: where setup installs on its
 * own, signing in installs gh first (its progress inline, then the reason and
 * Retry after a failure); a launch that never installs only links the download.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthState } from "../../../shared/github-auth";
import type { SetupItemState } from "../../../shared/setup";
import { I18nProvider, translate } from "../../lib/i18n";
import { useGithubAuthStore } from "../../stores/github-auth";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { fakeGithubAuth, githubState } from "../../test-support/github-auth";
import { fakeSetupApi, setupState } from "../../test-support/machine-setup";
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
const setup = fakeSetupApi(setupState("darwin"));
const openExternal = vi.fn(async () => {});
const writeText = vi.fn(async (_text: string) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { githubAuth: fake.api, setup: setup.api, system: { openExternal } },
});
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true });

const MISSING = { installed: false, version: null, authenticated: false, login: null, otherAccounts: [] };
const ghMissing = (partial: Partial<SetupItemState> = {}, automatic = true) =>
	setupState(
		"darwin",
		{ gh: { phase: "idle", presence: { kind: "missing" }, method: "brew", ...partial } },
		{ automatic },
	);

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
	useMachineSetupStore.getState().reset();
	setup.current.state = setupState("darwin");
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

	it("links the download without a sign-in when this launch never installs tools, and words a failed sign-in", async () => {
		setup.current.state = ghMissing({}, false);
		await mount(githubState({ status: MISSING }));
		expect(text()).toContain(translate("githubAuth.missing.title"));
		expect(button(translate("githubAuth.signIn"))).toBeUndefined();
		expect(button(translate("githubAuth.missing.download"))).toBeDefined();
		await act(async () => fake.push(githubState({ flow: { state: "failed", reason: "timeout" } })));
		expect(text()).toContain(translate("githubAuth.failed.timeout"));
		expect(button(translate("common.retry"))).toBeDefined();
	});

	it("signs in with gh missing: the click installs it first, with its progress inline and Cancel", async () => {
		setup.current.state = ghMissing({ phase: "backoff" });
		await mount(githubState({ status: MISSING }));
		expect(text()).toContain(translate("githubAuth.missing.autoInstall"));
		expect(text()).not.toContain(translate("githubAuth.missing.title"));
		fake.set(githubState({ status: MISSING, flow: { state: "installing" } }));
		await act(async () => button(translate("githubAuth.signIn"))?.click());
		expect(fake.api.startLogin).toHaveBeenCalledOnce();
		const card = () => document.querySelector('[data-testid="github-sign-in"]');
		expect(card()?.getAttribute("data-github-phase")).toBe("installing");
		expect(text()).toContain(translate("connectInstall.installing", { name: "GitHub CLI" }));

		const progress = {
			step: 1,
			steps: 1,
			startedAt: Date.now(),
			download: { received: 1_048_576, total: 4_194_304 },
		};
		await act(async () => setup.push(ghMissing({ phase: "running", progress })));
		expect(text()).toContain(translate("connectInstall.installing", { name: "GitHub CLI" }));
		expect(document.querySelector("[data-setup-progress]")?.textContent).toContain("1.0 MB");
		await act(async () => button(translate("common.cancel"))?.click());
		expect(fake.api.cancelLogin).toHaveBeenCalledOnce();
	});

	it("after an install that failed shows setup's reason and Retry, which signs in (and installs) again", async () => {
		setup.current.state = ghMissing({ phase: "failed", failure: { reason: "network", exitCode: 6 } });
		await mount(githubState({ status: MISSING, flow: { state: "failed", reason: "gh_install_failed" } }));
		expect(text()).toContain(translate("connectInstall.failed", { name: "GitHub CLI" }));
		expect(text()).toContain(translate("machineSetup.reason.network"));
		await act(async () => button(translate("common.retry"))?.click());
		expect(fake.api.startLogin).toHaveBeenCalledOnce();
	});

	it("shows setup's own background install of gh, then reads the sign-in again once gh is found", async () => {
		setup.current.state = ghMissing({ phase: "running" });
		await mount(githubState({ status: MISSING }));
		expect(document.querySelector('[data-testid="github-sign-in"]')?.getAttribute("data-github-phase")).toBe(
			"installing",
		);
		fake.api.refresh.mockClear();
		await act(async () => setup.push(setupState("darwin")));
		expect(fake.api.refresh).toHaveBeenCalledWith(true);
	});
});
