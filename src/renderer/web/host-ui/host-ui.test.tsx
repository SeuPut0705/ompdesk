/**
 * The sheets a web page shows for what a desktop does natively (design §2.4): the file action sheet, the
 * image save sheet, the computer's folder/file browser, the $EDITOR and models.yml editors, and the quit and
 * restart confirmations. Each is driven through its buttons with a faked `HostActions`; `WebHostUi` is
 * driven through the hooks the shim calls.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codedError } from "../../../shared/ipc-error-codes";
import type { WebHostListing } from "../../../shared/web-host";
import { I18nProvider, translate } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { type HostActions, webHostHooks } from "../host-hooks";
import { setWebRuntime } from "../runtime";
import { ConfirmSheet } from "./ConfirmSheet";
import { EditorSheet } from "./EditorSheet";
import { HostBrowserSheet } from "./HostBrowserSheet";
import { type HostPrompt, useHostUiStore } from "./host-ui-store";
import { ModelsConfigSheet } from "./ModelsConfigSheet";
import { PathActionsSheet } from "./PathActionsSheet";
import { SaveImageSheet } from "./SaveImageSheet";
import { WebHostUi } from "./WebHostUi";

// CodeMirror is not what these tests are about: a button stands in for "the person typed", appending text.
vi.mock("../../components/common/TextEditor", async () => {
	const { createElement } = await import("react");
	return {
		TextEditor: (props: { value: string; onChange: (value: string) => void; ariaLabel: string }) =>
			createElement(
				"button",
				{ "data-fake-editor": props.value, onClick: () => props.onChange(`${props.value} edited`), type: "button" },
				props.ariaLabel,
			),
	};
});

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// After the DOM globals: react-dom reads `document`/`window` when it loads.
const { createRoot } = await import("react-dom/client");

let root: Root | undefined;

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}

/** Let promises and the filter debounce settle inside `act`. */
async function settle(ms = 0): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, ms));
	});
}

const $ = (selector: string): Element | null => document.querySelector(selector) as Element | null;
const text = (): string => document.body.textContent ?? "";

async function click(selector: string): Promise<void> {
	const target = $(selector) as unknown as { click(): void } | null;
	if (!target) throw new Error(`no ${selector}`);
	await act(async () => target.click());
	await settle();
}

async function clickText(label: string): Promise<void> {
	const target = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === label) as
		| (Element & { click(): void })
		| undefined;
	if (!target) throw new Error(`no button "${label}"`);
	await act(async () => target.click());
	await settle();
}

function hostActions(overrides: Partial<HostActions> = {}): HostActions {
	return {
		openExternalOnComputer: vi.fn(async () => {}),
		openPathOnComputer: vi.fn(async () => ({ ok: true as const })),
		revealPathOnComputer: vi.fn(async () => ({ ok: true as const })),
		editOnComputer: vi.fn(async () => ({ ok: true, unavailable: false, text: "from the computer" })),
		openModelsConfigOnComputer: vi.fn(async () => ({ path: "/agent/models.yml", opened: true })),
		listDirs: vi.fn(async () => listing("/home/u", [])),
		saveToHost: vi.fn(async () => ({ ok: true as const, path: "/home/u/Pictures/shot.png" })),
		modelsConfigRead: vi.fn(async () => ({
			path: "/agent/models.yml",
			text: "providers: {}",
			exists: true,
			stamp: "s1",
		})),
		modelsConfigWrite: vi.fn(async () => ({ ok: true as const, stamp: "s2" })),
		downloadToPhone: vi.fn(async () => ({ ok: true as const })),
		saveBytesToPhone: vi.fn(async () => ({ saved: true })),
		pickPhoneFiles: vi.fn(async () => ["/uploads/a.txt"]),
		...overrides,
	};
}

function listing(path: string, entries: Array<{ name: string; directory: boolean; size?: number }>): WebHostListing {
	return {
		path,
		parent: path === "/" ? null : path.slice(0, Math.max(1, path.lastIndexOf("/"))),
		home: "/home/u",
		truncated: false,
		entries: entries.map(entry => ({
			name: entry.name,
			path: `${path}/${entry.name}`,
			directory: entry.directory,
			size: entry.directory ? null : (entry.size ?? 10),
		})),
	} as WebHostListing;
}

beforeEach(() => {
	useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useHostUiStore.getState().reset();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

describe("PathActionsSheet", () => {
	const open = (host: HostActions, resolve = vi.fn()): Extract<HostPrompt, { kind: "openPath" }> => ({
		kind: "openPath",
		path: "/work/notes/todo.md",
		host,
		resolve,
	});

	it("offers phone, computer and download for an open, naming the file", async () => {
		await mount(<PathActionsSheet onSettled={() => {}} prompt={open(hostActions())} />);
		expect(text()).toContain(translate("hostUi.openPath.title", { name: "todo.md" }));
		expect($('[data-host-action="phone"]')?.textContent).toContain(translate("hostUi.openPath.viewOnPhone"));
		expect($('[data-host-action="computer"]')?.textContent).toContain(translate("hostUi.openPath.openOnComputer"));
		expect($('[data-host-action="download"]')?.textContent).toContain(translate("hostUi.openPath.download"));
	});

	it("views the file on the phone through the Files viewer, without touching the computer", async () => {
		const host = hostActions();
		const resolve = vi.fn();
		const onSettled = vi.fn();
		const openFilePreview = vi.spyOn(useUiStore.getState(), "openFilePreview").mockImplementation(() => {});
		await mount(<PathActionsSheet onSettled={onSettled} prompt={open(host, resolve)} />);
		await click('[data-host-action="phone"]');
		expect(openFilePreview).toHaveBeenCalledWith("/work/notes/todo.md");
		expect(host.openPathOnComputer).not.toHaveBeenCalled();
		expect(resolve).toHaveBeenCalledWith({ ok: true });
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("opens it on the computer and says so", async () => {
		const host = hostActions();
		const resolve = vi.fn();
		await mount(<PathActionsSheet onSettled={() => {}} prompt={open(host, resolve)} />);
		await click('[data-host-action="computer"]');
		expect(host.openPathOnComputer).toHaveBeenCalledWith("/work/notes/todo.md", undefined);
		expect(resolve).toHaveBeenCalledWith({ ok: true });
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(
			translate("hostUi.openPath.openedOnComputer"),
		);
	});

	it("downloads to the phone", async () => {
		const host = hostActions();
		await mount(<PathActionsSheet onSettled={() => {}} prompt={{ ...open(host), tabId: "t1" }} />);
		await click('[data-host-action="download"]');
		expect(host.downloadToPhone).toHaveBeenCalledWith("/work/notes/todo.md", "t1");
	});

	it("keeps the sheet open under the host's refusal, as a sentence", async () => {
		const host = hostActions({
			openPathOnComputer: vi.fn(async () => ({ ok: false as const, error: "Denied by the host" })),
		});
		const resolve = vi.fn();
		const onSettled = vi.fn();
		await mount(<PathActionsSheet onSettled={onSettled} prompt={open(host, resolve)} />);
		await click('[data-host-action="computer"]');
		expect($("[data-host-sheet-error]")?.textContent).toContain("Denied by the host");
		expect(resolve).not.toHaveBeenCalled();
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("tells a device without computer control where to switch it on", async () => {
		const host = hostActions({
			openPathOnComputer: vi.fn(async () => {
				throw codedError("web_forbidden", "desktop-control is off");
			}),
		});
		await mount(<PathActionsSheet onSettled={() => {}} prompt={open(host)} />);
		await click('[data-host-action="computer"]');
		expect($("[data-host-sheet-error]")?.textContent).toBe(translate("hostUi.computerOff"));
	});

	it("shows a reveal in Files or on the computer, with no download", async () => {
		const host = hostActions();
		const revealInFiles = vi.spyOn(useUiStore.getState(), "revealInFiles").mockImplementation(() => {});
		await mount(
			<PathActionsSheet
				onSettled={() => {}}
				prompt={{ kind: "revealPath", path: "/work/a.ts", host, resolve: vi.fn() }}
			/>,
		);
		expect($('[data-host-action="download"]')).toBeNull();
		expect(text()).toContain(translate("hostUi.revealPath.title", { name: "a.ts" }));
		await click('[data-host-action="phone"]');
		expect(revealInFiles).toHaveBeenCalledWith("/work/a.ts");
	});

	it("resolves ok when the sheet is dismissed, so the caller never hangs", async () => {
		const resolve = vi.fn();
		const onSettled = vi.fn();
		await mount(<PathActionsSheet onSettled={onSettled} prompt={open(hostActions(), resolve)} />);
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			document.dispatchEvent(event);
		});
		expect(resolve).toHaveBeenCalledWith({ ok: true });
		expect(onSettled).toHaveBeenCalledTimes(1);
	});
});

describe("ConfirmSheet", () => {
	const seedRunning = (running: number) =>
		useTabsStore.setState({
			tabs: Array.from({ length: 3 }, (_, index) => ({
				kind: "agent" as const,
				id: `t${index}`,
				cwd: "/p",
				status: index < running ? ("running" as const) : ("ready" as const),
				unreadDone: false,
			})),
		});

	it("a quit names the running turns and answers true on confirm", async () => {
		seedRunning(2);
		const resolve = vi.fn();
		const onSettled = vi.fn();
		await mount(<ConfirmSheet onSettled={onSettled} prompt={{ kind: "quit", resolve }} />);
		expect($("[data-host-running]")?.textContent).toBe(translate("hostUi.quit.running", { count: 2 }));
		await click("[data-host-confirm]");
		expect(resolve).toHaveBeenCalledWith(true);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("says nothing about turns when none run, and Cancel answers false", async () => {
		seedRunning(0);
		const resolve = vi.fn();
		await mount(<ConfirmSheet onSettled={() => {}} prompt={{ kind: "update", resolve }} />);
		expect($("[data-host-running]")).toBeNull();
		expect(text()).toContain(translate("hostUi.update.title"));
		await clickText(translate("hostUi.cancel"));
		expect(resolve).toHaveBeenCalledWith(false);
	});
});

describe("HostBrowserSheet", () => {
	it("starts at the computer's home, opens a folder, and chooses the folder on screen", async () => {
		const listDirs = vi.fn(async (request: { path?: string }) =>
			request.path === "/home/u/code"
				? listing("/home/u/code", [{ name: "app", directory: true }])
				: listing("/home/u", [
						{ name: "code", directory: true },
						{ name: "notes.txt", directory: false, size: 2048 },
					]),
		);
		const onDone = vi.fn();
		await mount(<HostBrowserSheet host={hostActions({ listDirs })} mode="folder" onDone={onDone} />);
		await settle();
		expect(listDirs).toHaveBeenCalledWith({ path: undefined, query: undefined, files: false });
		expect(document.querySelectorAll('[data-host-entry="folder"]')).toHaveLength(1);

		await click('[data-host-entry="folder"] button');
		expect(listDirs).toHaveBeenLastCalledWith({ path: "/home/u/code", query: undefined, files: false });
		await clickText(translate("hostUi.browser.chooseFolder"));
		expect(onDone).toHaveBeenCalledWith(["/home/u/code"]);
	});

	it("picks a file in file mode, hiding files the filter excludes", async () => {
		const host = hostActions({
			listDirs: vi.fn(async () =>
				listing("/home/u", [
					{ name: "a.png", directory: false },
					{ name: "b.txt", directory: false },
				]),
			),
		});
		const onDone = vi.fn();
		await mount(
			<HostBrowserSheet
				filters={[{ name: "Images", extensions: ["png"] }]}
				host={host}
				mode="file"
				onDone={onDone}
			/>,
		);
		await settle();
		const files = document.querySelectorAll('[data-host-entry="file"]');
		expect(files).toHaveLength(1);
		expect(files[0]?.textContent).toContain("a.png");
		await click('[data-host-entry="file"] button');
		expect(onDone).toHaveBeenCalledWith(["/home/u/a.png"]);
	});

	it("save mode answers the folder shown plus the proposed file name", async () => {
		const host = hostActions({ listDirs: vi.fn(async () => listing("/home/u/Pictures", [])) });
		const onDone = vi.fn();
		await mount(<HostBrowserSheet defaultPath="/home/u/Pictures/shot.png" host={host} mode="save" onDone={onDone} />);
		await settle();
		await clickText(translate("hostUi.browser.saveHere"));
		expect(onDone).toHaveBeenCalledWith(["/home/u/Pictures/shot.png"]);
	});

	it("shows why a folder could not be read, and says when it is empty", async () => {
		const host = hostActions({
			listDirs: vi.fn(async () => {
				throw codedError("web_forbidden", "no");
			}),
		});
		await mount(<HostBrowserSheet host={host} mode="folder" onDone={() => {}} />);
		await settle();
		expect($("[data-host-sheet-error]")?.textContent).toContain(translate("hostUi.computerOff"));
	});

	it("reports an empty folder", async () => {
		await mount(<HostBrowserSheet host={hostActions()} mode="folder" onDone={() => {}} />);
		await settle();
		expect(text()).toContain(translate("hostUi.browser.empty"));
	});

	it("answers null when it is closed", async () => {
		const onDone = vi.fn();
		await mount(<HostBrowserSheet host={hostActions()} mode="folder" onDone={onDone} />);
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			document.dispatchEvent(event);
		});
		expect(onDone).toHaveBeenCalledWith(null);
	});

	it("file mode can take files from this device instead", async () => {
		const host = hostActions();
		const onDone = vi.fn();
		await mount(<HostBrowserSheet host={host} mode="file" onDone={onDone} />);
		await settle();
		await clickText(translate("hostUi.browser.fromPhone"));
		expect(onDone).toHaveBeenCalledWith(["/uploads/a.txt"]);
	});
});

describe("SaveImageSheet", () => {
	const prompt = (host: HostActions, resolve = vi.fn()): Extract<HostPrompt, { kind: "saveImage" }> => ({
		kind: "saveImage",
		name: "shot.png",
		mime: "image/png",
		base64: "AAAA",
		host,
		resolve,
	});

	it("saves to this device", async () => {
		const host = hostActions();
		const resolve = vi.fn();
		await mount(<SaveImageSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await click('[data-host-action="phone"]');
		expect(host.saveBytesToPhone).toHaveBeenCalledWith("shot.png", "image/png", "AAAA");
		expect(resolve).toHaveBeenCalledWith({ saved: true });
	});

	it("saves into a folder picked on the computer", async () => {
		const host = hostActions({ listDirs: vi.fn(async () => listing("/home/u/Pictures", [])) });
		const resolve = vi.fn();
		await mount(<SaveImageSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await click('[data-host-action="computer"]');
		await settle();
		expect($('[data-host-sheet="browse"]')).not.toBeNull();
		await clickText(translate("hostUi.browser.chooseFolder"));
		expect(host.saveToHost).toHaveBeenCalledWith({ dir: "/home/u/Pictures", name: "shot.png", data: "AAAA" });
		expect(resolve).toHaveBeenCalledWith({ saved: true });
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(
			translate("hostUi.save.done", { path: "/home/u/Pictures/shot.png" }),
		);
	});

	it("returns to the choice with the reason when the computer refuses the write", async () => {
		const host = hostActions({
			listDirs: vi.fn(async () => listing("/home/u/Pictures", [])),
			saveToHost: vi.fn(async () => ({ ok: false as const, error: "Read-only folder" })),
		});
		const resolve = vi.fn();
		await mount(<SaveImageSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await click('[data-host-action="computer"]');
		await settle();
		await clickText(translate("hostUi.browser.chooseFolder"));
		expect($('[data-host-sheet="saveImage"]')).not.toBeNull();
		expect($("[data-host-sheet-error]")?.textContent).toContain("Read-only folder");
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe("EditorSheet", () => {
	const prompt = (host: HostActions, resolve = vi.fn()): Extract<HostPrompt, { kind: "editor" }> => ({
		kind: "editor",
		content: "draft",
		host,
		resolve,
	});

	it("hands back the edited text in the desktop's {ok, text} shape", async () => {
		const resolve = vi.fn();
		await mount(<EditorSheet onSettled={() => {}} prompt={prompt(hostActions(), resolve)} />);
		await click("[data-fake-editor]");
		await clickText(translate("hostUi.editor.done"));
		expect(resolve).toHaveBeenCalledWith({ ok: true, unavailable: false, text: "draft edited" });
	});

	it("closing it is a cancelled edit, with no text", async () => {
		const resolve = vi.fn();
		await mount(<EditorSheet onSettled={() => {}} prompt={prompt(hostActions(), resolve)} />);
		await act(async () => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			document.dispatchEvent(event);
		});
		expect(resolve).toHaveBeenCalledWith({ ok: false, unavailable: false, text: null });
	});

	it("edits on the computer with the text so far, waits, and takes the result", async () => {
		let release: (value: { ok: boolean; unavailable: boolean; text: string | null }) => void = () => {};
		const host = hostActions({
			editOnComputer: vi.fn(
				() =>
					new Promise<{ ok: boolean; unavailable: boolean; text: string | null }>(resolve => {
						release = resolve;
					}),
			),
		});
		const resolve = vi.fn();
		await mount(<EditorSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await click("[data-fake-editor]");
		await clickText(translate("hostUi.editor.onComputer"));
		expect(host.editOnComputer).toHaveBeenCalledWith("draft edited");
		expect($("[data-host-editor-waiting]")).not.toBeNull();
		await act(async () => release({ ok: true, unavailable: false, text: "from vim" }));
		expect(resolve).toHaveBeenCalledWith({ ok: true, unavailable: false, text: "from vim" });
	});

	it("a failed computer edit shows the reason and leaves the sheet open", async () => {
		const host = hostActions({
			editOnComputer: vi.fn(async () => ({ ok: false, unavailable: false, text: null, error: "No $EDITOR" })),
		});
		const resolve = vi.fn();
		await mount(<EditorSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await clickText(translate("hostUi.editor.onComputer"));
		expect($("[data-host-sheet-error]")?.textContent).toBe("No $EDITOR");
		expect($("[data-host-editor-waiting]")).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe("ModelsConfigSheet", () => {
	const prompt = (host: HostActions, resolve = vi.fn()): Extract<HostPrompt, { kind: "models" }> => ({
		kind: "models",
		host,
		resolve,
	});

	it("loads the file and saves the edited text against the stamp it was read at", async () => {
		const host = hostActions();
		const resolve = vi.fn();
		const onSettled = vi.fn();
		await mount(<ModelsConfigSheet onSettled={onSettled} prompt={prompt(host, resolve)} />);
		await settle();
		expect(text()).toContain("/agent/models.yml");
		await click("[data-fake-editor]");
		await clickText(translate("hostUi.models.save"));
		expect(host.modelsConfigWrite).toHaveBeenCalledWith({ text: "providers: {} edited", stamp: "s1" });
		expect(resolve).toHaveBeenCalledWith({ path: "/agent/models.yml", opened: true });
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(translate("hostUi.models.saved"));
	});

	it("shows the parser's reason under the editor and keeps the sheet open", async () => {
		const host = hostActions({
			modelsConfigWrite: vi.fn(async () => ({
				ok: false as const,
				error: "models.yml: Nested mappings are not allowed",
			})),
		});
		const resolve = vi.fn();
		await mount(<ModelsConfigSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await settle();
		await clickText(translate("hostUi.models.save"));
		expect($("[data-host-sheet-error]")?.textContent).toBe("models.yml: Nested mappings are not allowed");
		expect(resolve).not.toHaveBeenCalled();
	});

	it("a file that changed on the computer blocks the save until it is reloaded", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce({ path: "/agent/models.yml", text: "a: 1", exists: true, stamp: "s1" })
			.mockResolvedValueOnce({ path: "/agent/models.yml", text: "a: 2", exists: true, stamp: "s9" });
		const host = hostActions({
			modelsConfigRead: read,
			modelsConfigWrite: vi.fn(async () => ({
				ok: false as const,
				error: "/agent/models.yml changed on disk since it was opened. Nothing was written; reopen it.",
			})),
		});
		await mount(<ModelsConfigSheet onSettled={() => {}} prompt={prompt(host)} />);
		await settle();
		await clickText(translate("hostUi.models.save"));
		const save = [...document.querySelectorAll("button")].find(
			button => button.textContent?.trim() === translate("hostUi.models.save"),
		);
		expect(save?.hasAttribute("disabled")).toBe(true);
		await clickText(translate("hostUi.models.reload"));
		expect(read).toHaveBeenCalledTimes(2);
		expect($("[data-fake-editor]")?.getAttribute("data-fake-editor")).toBe("a: 2");
		expect(document.querySelector("[data-host-sheet-error]")).toBeNull();
	});

	it("says so when the file could not be read", async () => {
		const host = hostActions({
			modelsConfigRead: vi.fn(async () => {
				throw codedError("web_forbidden", "settings-write is off");
			}),
		});
		await mount(<ModelsConfigSheet onSettled={() => {}} prompt={prompt(host)} />);
		await settle();
		expect($("[data-host-sheet-error]")?.textContent).toContain(translate("hostUi.computerOff"));
	});

	it("notes a file that does not exist yet", async () => {
		const host = hostActions({
			modelsConfigRead: vi.fn(async () => ({
				path: "/agent/models.yml",
				text: "providers: {}\n",
				exists: false,
				stamp: "missing",
			})),
		});
		await mount(<ModelsConfigSheet onSettled={() => {}} prompt={prompt(host)} />);
		await settle();
		expect(text()).toContain(translate("hostUi.models.missing"));
	});

	it("edits on the computer through the desktop handler", async () => {
		const host = hostActions();
		const resolve = vi.fn();
		await mount(<ModelsConfigSheet onSettled={() => {}} prompt={prompt(host, resolve)} />);
		await settle();
		await clickText(translate("hostUi.models.onComputer"));
		expect(host.openModelsConfigOnComputer).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith({ path: "/agent/models.yml", opened: true });
	});
});

describe("WebHostUi", () => {
	const runtime = (host: HostActions) => ({
		host,
		connectionState: () => "open" as never,
		onConnectionState: () => () => {},
		features: () => null,
		emitMenuAction: () => {},
		setResyncHandler: () => () => {},
		requestNotifications: async () => "granted" as const,
	});

	it("shows nothing and registers nothing on the desktop", async () => {
		await mount(<WebHostUi />);
		expect(document.body.textContent).toBe("");
		expect(webHostHooks().confirmQuit).toBeUndefined();
	});

	it("turns each hook call into a sheet, one at a time, and settles it with the answer", async () => {
		setWebRuntime(runtime(hostActions()));
		await mount(<WebHostUi />);
		let quit: Promise<boolean> | undefined;
		let update: Promise<boolean> | undefined;
		await act(async () => {
			quit = webHostHooks().confirmQuit?.();
			update = webHostHooks().confirmUpdateApply?.();
		});
		expect($('[data-host-sheet="quit"]')).not.toBeNull();
		expect($('[data-host-sheet="update"]')).toBeNull();
		await click("[data-host-confirm]");
		await expect(quit).resolves.toBe(true);
		expect($('[data-host-sheet="update"]')).not.toBeNull();
		await clickText(translate("hostUi.cancel"));
		await expect(update).resolves.toBe(false);
	});

	it("opens a link on this device and offers the computer in a toast", async () => {
		const host = hostActions();
		setWebRuntime(runtime(host));
		const opened = vi.fn();
		(window as unknown as { open: typeof opened }).open = opened;
		await mount(<WebHostUi />);
		await webHostHooks().openExternal?.("https://example.com/x");
		expect(opened).toHaveBeenCalledWith("https://example.com/x", "_blank", "noopener,noreferrer");
		const toast = useToastStore.getState().toasts.at(-1);
		expect(toast?.message).toBe(translate("hostUi.link.opened"));
		expect(toast?.action?.label).toBe(translate("hostUi.link.onComputer"));
		toast?.action?.run();
		expect(host.openExternalOnComputer).toHaveBeenCalledWith("https://example.com/x");
	});
});
