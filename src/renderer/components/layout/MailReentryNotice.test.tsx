import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailAccount } from "../../../shared/mail-accounts";
import { I18nProvider } from "../../lib/i18n";
import { useMailReentryStore } from "../../stores/mail-reentry";
import { useUiStore } from "../../stores/ui";
import { MailReentryNotice } from "./MailReentryNotice";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
	click: () => void;
	getAttribute: (name: string) => string | null;
}

const account = (id: string, label: string, needsReentry: boolean): MailAccount => ({
	id,
	label,
	host: "imap.example.com",
	port: 993,
	username: `${id}@example.com`,
	mailbox: "INBOX",
	address: `${id}@example.com`,
	hasPassword: !needsReentry,
	needsReentry,
});

let container: TestElement;
let root: Root;
const list = vi.fn();

async function mount(accounts: MailAccount[]): Promise<void> {
	list.mockResolvedValue({ accounts });
	Reflect.set(window, "omp", { mailAccounts: { command: list } });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MailReentryNotice />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useMailReentryStore.setState({ accounts: [], dismissedFor: null, editRequest: null });
	useUiStore.setState({ destination: "session" });
	list.mockReset();
});

describe("MailReentryNotice", () => {
	it("shows nothing when no account needs its password again", async () => {
		await mount([account("a", "Work", false)]);
		expect(list).toHaveBeenCalledWith({ action: "list" });
		expect(container.querySelector("[data-mail-reentry-notice]")).toBeNull();
	});

	it("names every account that needs it in one notice, not one per account", async () => {
		await mount([account("a", "Work", true), account("b", "Home", true), account("c", "Fine", false)]);
		expect(container.querySelectorAll("[data-mail-reentry-notice]")).toHaveLength(1);
		const text = container.textContent ?? "";
		expect(text).toContain("Work, Home");
		expect(text).not.toContain("Fine");
		expect(text).toContain("need their passwords again");
	});

	it("says it in the singular for one account", async () => {
		await mount([account("a", "Work", true)]);
		expect(container.textContent).toContain("The email account Work needs its password again");
	});

	it("leads to the first account's password field: Settings › Schedules and an edit request", async () => {
		await mount([account("a", "Work", true), account("b", "Home", true)]);
		const action = container
			.querySelectorAll("button")
			.find(button => (button.textContent ?? "").includes("Enter password"));
		expect(action).toBeDefined();
		await act(async () => {
			action?.click();
		});
		expect(useMailReentryStore.getState().editRequest).toBe("a");
		expect(useUiStore.getState().destination).toBe("settings");
		expect(useUiStore.getState().settingsTab).toBe("schedules");
	});

	it("stays closed once dismissed, and comes back for a different set of accounts", async () => {
		await mount([account("a", "Work", true)]);
		const close = container
			.querySelectorAll("button")
			.find(button => button.getAttribute("aria-label") === "Dismiss the email password notice");
		await act(async () => {
			close?.click();
		});
		expect(container.querySelector("[data-mail-reentry-notice]")).toBeNull();
		await act(async () => {
			useMailReentryStore.getState().adopt([account("a", "Work", true), account("b", "Home", true)]);
		});
		expect(container.querySelector("[data-mail-reentry-notice]")).not.toBeNull();
	});
});
