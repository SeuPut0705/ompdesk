/**
 * Settings › Schedules › Email accounts: the list main keeps (src/main/mail-accounts.ts), the add/edit dialog with its
 * write-only password, Test on a row, Remove behind a confirmation, and the one line a paired host's tab gets instead.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MailAccount,
	MailAccountsRequest,
	MailAccountsState,
	MailAccountTest,
} from "../../../shared/mail-accounts";
import { I18nProvider } from "../../lib/i18n";
import { useToastStore } from "../../stores/toast";
import { MailAccounts } from "./MailAccounts";

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

const WORK: MailAccount = {
	id: "a1",
	label: "Work mail",
	host: "imap.example.com",
	port: 993,
	username: "owner@example.com",
	mailbox: "INBOX",
	address: "owner@example.com",
	hasPassword: true,
};
const PERSONAL: MailAccount = {
	id: "a2",
	label: "Personal",
	host: "imap.home.test",
	port: 1993,
	username: "me",
	mailbox: "Bots",
	address: "me",
	hasPassword: true,
};

let state: MailAccountsState = { accounts: [WORK, PERSONAL] };
let failList = false;
let failSave = false;
const command = vi.fn(async (request: Exclude<MailAccountsRequest, { action: "test" }>): Promise<MailAccountsState> => {
	if (request.action === "list" && failList) throw new Error("keystore locked");
	if (request.action === "save") {
		if (failSave) throw new Error("keystore unavailable");
		const saved: MailAccount = {
			...request.draft,
			id: request.id ?? "new",
			address: request.draft.username,
			hasPassword: Boolean(request.draft.password) || state.accounts.some(item => item.id === request.id),
		};
		state = { accounts: [...state.accounts.filter(item => item.id !== saved.id), saved] };
	}
	if (request.action === "remove") state = { accounts: state.accounts.filter(item => item.id !== request.id) };
	return state;
});
let testResult: MailAccountTest | Error = { ok: true, messages: 12 };
const test = vi.fn(async (_id: string): Promise<MailAccountTest> => {
	if (testResult instanceof Error) throw testResult;
	return testResult;
});
Object.assign(window as unknown as Record<string, unknown>, { omp: { mailAccounts: { command, test } } });

const roots: Root[] = [];
async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}
async function mount(device?: string): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MailAccounts device={device} />
			</I18nProvider>,
		);
	});
	await settle();
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
	state = { accounts: [WORK, PERSONAL] };
	failList = false;
	failSave = false;
	testResult = { ok: true, messages: 12 };
	command.mockClear();
	test.mockClear();
	useToastStore.setState({ toasts: [] } as never);
});

function reactProps(element: object): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (event: object) => void>;
}

async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await settle();
}

function button(label: string): object | null {
	return (
		[...document.body.querySelectorAll("button")].find(
			item => item.getAttribute("aria-label") === label || (item.textContent ?? "").trim() === label,
		) ?? null
	);
}

async function type(label: string, value: string): Promise<void> {
	const field = [...document.body.querySelectorAll("label")].find(item => (item.textContent ?? "").trim() === label);
	const id = field?.getAttribute("for");
	const control = id ? document.body.querySelector(`[id="${id}"]`) : null;
	if (!control) throw new Error(`field "${label}" missing`);
	await act(async () => reactProps(control).onChange({ target: { value }, currentTarget: { value } }));
}

async function submit(): Promise<void> {
	await act(async () =>
		reactProps(document.body.querySelector("[data-mail-account-form]") as object).onSubmit({ preventDefault() {} }),
	);
	await settle();
}

async function menuItem(account: string, item: string): Promise<void> {
	await act(async () => (button(`Actions for ${account}`) as HTMLButtonElement).click());
	const found = [...document.body.querySelectorAll('[role="menuitem"]')].find(
		node => (node.textContent ?? "").trim() === item,
	) as HTMLElement | undefined;
	await act(async () => found?.click());
}

const row = (id: string) => document.body.querySelector(`[data-mail-account="${id}"]`);

describe("MailAccounts", () => {
	it("lists the accounts with their server and mailbox, and says where the password goes", async () => {
		await mount();
		expect(command).toHaveBeenCalledWith({ action: "list" });
		expect(row("a1")?.textContent).toContain("Work mail");
		expect(row("a1")?.textContent).toContain("owner@example.com @ imap.example.com · INBOX");
		expect(row("a2")?.textContent).toContain("me @ imap.home.test · Bots");
		expect(document.body.querySelector("[data-mail-note]")?.textContent).toBe(
			"The password is stored encrypted on this computer and never shown to the bot. The bot names an account by its label when it sets an email routine.",
		);
		expect(document.body.querySelector("[data-mail-elsewhere]")).toBeNull();
	});

	it("shows a skeleton until the list lands and a retry when it cannot be read", async () => {
		failList = true;
		await mount();
		expect(document.body.textContent).toContain("Couldn't load email accounts");
		expect(document.body.textContent).toContain("keystore locked");
		failList = false;
		await click(button("Retry"));
		expect(row("a1")).not.toBeNull();
	});

	it("validates the add form, then sends the exact account with its password", async () => {
		state = { accounts: [] };
		await mount();
		expect(document.body.querySelector("[data-mail-empty]")).not.toBeNull();

		await click(document.body.querySelector("[data-mail-account-new]"));
		await submit();
		expect(document.body.textContent).toContain("Give the account a label");
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: "save" }));

		await type("Label", "Work mail");
		await type("Server", "imap.example.com");
		await type("Username", "owner@example.com");
		await submit();
		expect(document.body.textContent).toContain("Enter the account's password.");

		await type("Port", "70000");
		await type("Password", "s3cret");
		await submit();
		expect(document.body.textContent).toContain("Enter a port from 1 to 65535.");

		await type("Port", "993");
		await submit();
		expect(command).toHaveBeenCalledWith({
			action: "save",
			draft: {
				label: "Work mail",
				host: "imap.example.com",
				port: 993,
				username: "owner@example.com",
				mailbox: "INBOX",
				password: "s3cret",
			},
		});
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		expect(row("new")?.textContent).toContain("Work mail");
		expect(document.body.textContent).not.toContain("s3cret");
	});

	it("edits an account without its password: the field says it is kept and none is sent", async () => {
		await mount();
		await menuItem("Work mail", "Edit");
		expect(document.body.textContent).toContain("A password is stored. Leave this empty to keep it.");
		const password = document.body.querySelector('input[type="password"]') as HTMLInputElement | null;
		expect(password?.getAttribute("value") ?? "").toBe("");

		await type("Mailbox", "Bots");
		await submit();
		const saved = command.mock.calls.map(([request]) => request).find(request => request.action === "save");
		expect(saved).toEqual({
			action: "save",
			id: "a1",
			draft: {
				label: "Work mail",
				host: "imap.example.com",
				port: 993,
				username: "owner@example.com",
				mailbox: "Bots",
			},
		});
		expect(saved && "draft" in saved && "password" in saved.draft).toBe(false);
		expect(row("a1")?.textContent).toContain("· Bots");
	});

	it("keeps the dialog open and toasts when main cannot save", async () => {
		await mount();
		await menuItem("Personal", "Edit");
		failSave = true;
		await submit();
		expect(document.body.querySelector("[data-mail-account-form]")).not.toBeNull();
		expect(useToastStore.getState().toasts.some(item => item.title === "Couldn't update the email accounts")).toBe(
			true,
		);
	});

	it("tests an account and shows the message count or the error on its row", async () => {
		await mount();
		await click(button("Test Work mail"));
		expect(test).toHaveBeenCalledWith("a1");
		expect(row("a1")?.querySelector("[data-mail-test-result]")?.textContent).toBe("Mailbox opened: 12 messages");
		expect(row("a2")?.querySelector("[data-mail-test-result]")).toBeNull();

		testResult = { ok: true, messages: 1 };
		await click(button("Test Work mail"));
		expect(row("a1")?.querySelector("[data-mail-test-result]")?.textContent).toBe("Mailbox opened: 1 message");

		testResult = { ok: false, error: "Login failed: invalid credentials" };
		await click(button("Test Personal"));
		expect(row("a2")?.querySelector("[data-mail-test-result]")?.textContent).toBe(
			"Login failed: invalid credentials",
		);

		testResult = new Error("link dropped");
		await click(button("Test Personal"));
		expect(row("a2")?.querySelector("[data-mail-test-result]")?.textContent).toBe("link dropped");
	});

	it("asks before removing an account, then sends remove", async () => {
		await mount();
		await menuItem("Work mail", "Remove");
		expect(document.body.textContent).toContain("Remove this email account?");
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: "remove" }));

		await click(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				item => (item.textContent ?? "").trim() === "Remove",
			) ?? null,
		);
		expect(command).toHaveBeenCalledWith({ action: "remove", id: "a1" });
		expect(row("a1")).toBeNull();
		expect(row("a2")).not.toBeNull();
	});

	it("on a paired host's tab only says the accounts are set on that computer", async () => {
		await mount("host-studio");
		expect(document.body.querySelector("[data-mail-elsewhere]")?.textContent).toBe(
			"Email accounts are set on that computer itself.",
		);
		expect(document.body.querySelector("[data-mail-account]")).toBeNull();
		expect(document.body.querySelector("[data-mail-account-new]")).toBeNull();
		expect(command).not.toHaveBeenCalled();
	});
});
