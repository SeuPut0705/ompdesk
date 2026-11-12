/**
 * `Menu`, `MenuItem` and `Tray` over the host protocol (PROTOCOL.md §7). A menu is built here from Electron's
 * template, its click handlers stay in Node, and the shell gets a plain description (`id`, `label`, `accelerator`, …)
 * and answers `menu.click` with the item's id. Roles that only act on a window or the app (`reload`, `zoomIn`, `cut`,
 * `quit`, …) are expanded here into the label, the accelerator Electron gives them and the action; roles that need
 * the platform's own menu machinery (macOS `services`, `hide`, `hideOthers`, `unhide`, `front`, `zoom`) go to the
 * shell as `role`.
 */
import { EventEmitter } from "node:events";
import type { Host } from "./host";
import type { NativeImage } from "./native-image";

interface Window {
	id: number;
	webContents: WindowContents;
	minimize(): void;
	close(): void;
	setFullScreen(on: boolean): void;
	isFullScreen(): boolean;
}

type PopupOptions = { window?: { id: number }; x?: number; y?: number; callback?: () => void };
type PopupFn = (menu: Menu, options: PopupOptions) => void;
interface WindowContents {
	reload(): void;
	reloadIgnoringCache(): void;
	toggleDevTools(): void;
	getZoomFactor(): number;
	setZoomFactor(factor: number): void;
	undo(): void;
	redo(): void;
	cut(): void;
	copy(): void;
	paste(): void;
	pasteAndMatchStyle(): void;
	selectAll(): void;
	delete(): void;
}

export interface MenuItemOptions {
	id?: string;
	label?: string;
	type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
	enabled?: boolean;
	visible?: boolean;
	checked?: boolean;
	accelerator?: string;
	sublabel?: string;
	toolTip?: string;
	role?: string;
	submenu?: MenuItemOptions[] | Menu;
	click?: (item: MenuItem, window: Window | undefined, event: unknown) => void;
	registerAccelerator?: boolean;
}

export interface MenuDeps {
	focusedWindow(): Window | null;
	quit(): void;
	showAboutPanel(): void;
}

const MAC = process.platform === "darwin";

/** Roles handled here: label, Electron's default accelerator and the action. */
const ROLES: Record<string, { label: string; accelerator?: string; run(window: Window | null, deps: MenuDeps): void }> =
	{
		undo: { label: "Undo", accelerator: "CommandOrControl+Z", run: w => w?.webContents.undo() },
		redo: {
			label: "Redo",
			accelerator: MAC ? "Shift+CommandOrControl+Z" : "Control+Y",
			run: w => w?.webContents.redo(),
		},
		cut: { label: "Cut", accelerator: "CommandOrControl+X", run: w => w?.webContents.cut() },
		copy: { label: "Copy", accelerator: "CommandOrControl+C", run: w => w?.webContents.copy() },
		paste: { label: "Paste", accelerator: "CommandOrControl+V", run: w => w?.webContents.paste() },
		pasteAndMatchStyle: {
			label: "Paste and Match Style",
			accelerator: "Shift+CommandOrControl+V",
			run: w => w?.webContents.pasteAndMatchStyle(),
		},
		delete: { label: "Delete", run: w => w?.webContents.delete() },
		selectAll: { label: "Select All", accelerator: "CommandOrControl+A", run: w => w?.webContents.selectAll() },
		reload: { label: "Reload", accelerator: "CommandOrControl+R", run: w => w?.webContents.reload() },
		forceReload: {
			label: "Force Reload",
			accelerator: "Shift+CommandOrControl+R",
			run: w => w?.webContents.reloadIgnoringCache(),
		},
		toggleDevTools: {
			label: "Toggle Developer Tools",
			accelerator: MAC ? "Alt+Command+I" : "Control+Shift+I",
			run: w => w?.webContents.toggleDevTools(),
		},
		resetZoom: { label: "Actual Size", accelerator: "CommandOrControl+0", run: w => w?.webContents.setZoomFactor(1) },
		zoomIn: {
			label: "Zoom In",
			accelerator: "CommandOrControl+Plus",
			run: w => w?.webContents.setZoomFactor(Math.min(5, w.webContents.getZoomFactor() * 1.2)),
		},
		zoomOut: {
			label: "Zoom Out",
			accelerator: "CommandOrControl+-",
			run: w => w?.webContents.setZoomFactor(Math.max(0.25, w.webContents.getZoomFactor() / 1.2)),
		},
		togglefullscreen: {
			label: "Toggle Full Screen",
			accelerator: MAC ? "Control+Command+F" : "F11",
			run: w => w?.setFullScreen(!w.isFullScreen()),
		},
		minimize: { label: "Minimize", accelerator: "CommandOrControl+M", run: w => w?.minimize() },
		close: { label: "Close", accelerator: "CommandOrControl+W", run: w => w?.close() },
		quit: { label: "Quit", accelerator: MAC ? "Command+Q" : undefined, run: (_w, deps) => deps.quit() },
		about: { label: "About", run: (_w, deps) => deps.showAboutPanel() },
	};

const NATIVE_ROLES = new Set(["services", "hide", "hideOthers", "unhide", "front", "zoom", "windowMenu", "appMenu"]);

let nextItem = 0;

export class MenuItem {
	readonly id: string;
	readonly commandId: string;
	label: string;
	type: NonNullable<MenuItemOptions["type"]>;
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	accelerator: string | undefined;
	sublabel: string | undefined;
	toolTip: string | undefined;
	role: string | undefined;
	submenu: Menu | undefined;
	readonly click: (event?: unknown, window?: Window, webContents?: unknown) => void;
	readonly #deps: MenuDeps;

	constructor(options: MenuItemOptions, deps: MenuDeps, toMenu: (items: MenuItemOptions[]) => Menu) {
		this.#deps = deps;
		this.commandId = `i${++nextItem}`;
		this.id = options.id ?? "";
		const role =
			options.role === undefined
				? undefined
				: ROLES[options.role]
					? options.role
					: options.role.toLowerCase() === "togglefullscreen"
						? "togglefullscreen"
						: options.role;
		const known = role === undefined ? undefined : ROLES[role];
		this.role = role;
		this.label = options.label ?? known?.label ?? "";
		this.type = options.type ?? (options.submenu ? "submenu" : "normal");
		this.enabled = options.enabled !== false;
		this.visible = options.visible !== false;
		this.checked = options.checked === true;
		this.accelerator = options.accelerator ?? known?.accelerator;
		this.sublabel = options.sublabel;
		this.toolTip = options.toolTip;
		this.submenu = Array.isArray(options.submenu) ? toMenu(options.submenu) : options.submenu;
		this.click = (event, window) => {
			if (this.type === "checkbox") this.checked = !this.checked;
			const target = window ?? deps.focusedWindow() ?? undefined;
			if (known && !options.click) known.run(target ?? null, deps);
			options.click?.(this, target, event);
		};
	}

	/** Runs the item as the shell reported a click (`checked` is the state the platform toggled to). */
	activate(checked?: boolean): void {
		if (checked !== undefined) this.checked = checked;
		const checkbox = this.type === "checkbox";
		if (checkbox && checked !== undefined) {
			// The platform already toggled it; `click` toggles once more, so set it back first.
			this.checked = !checked;
		}
		this.click(undefined, this.#deps.focusedWindow() ?? undefined);
	}

	toWire(): Record<string, unknown> {
		const native = this.role !== undefined && (NATIVE_ROLES.has(this.role) || (this.role === "about" && MAC));
		return {
			id: this.commandId,
			label: this.label,
			type: this.type,
			enabled: this.enabled,
			visible: this.visible,
			checked: this.checked,
			...(this.accelerator === undefined ? {} : { accelerator: this.accelerator }),
			...(this.sublabel === undefined ? {} : { sublabel: this.sublabel }),
			...(this.toolTip === undefined ? {} : { toolTip: this.toolTip }),
			...(native && this.role !== undefined ? { role: this.role } : {}),
			...(this.submenu ? { submenu: this.submenu.toWire() } : {}),
		};
	}

	find(commandId: string): MenuItem | undefined {
		if (this.commandId === commandId) return this;
		return this.submenu?.findCommand(commandId);
	}
}

export class Menu extends EventEmitter {
	readonly items: MenuItem[] = [];
	readonly #deps: MenuDeps;
	readonly #popup: PopupFn;
	menuId = 0;

	constructor(deps: MenuDeps, popup: PopupFn) {
		super();
		this.#deps = deps;
		this.#popup = popup;
	}

	append(item: MenuItem): void {
		this.items.push(item);
	}

	insert(position: number, item: MenuItem): void {
		this.items.splice(position, 0, item);
	}

	getMenuItemById(id: string): MenuItem | null {
		const walk = (items: MenuItem[]): MenuItem | null => {
			for (const item of items) {
				if (item.id === id) return item;
				const inner = item.submenu ? walk(item.submenu.items) : null;
				if (inner) return inner;
			}
			return null;
		};
		return walk(this.items);
	}

	/** Adds the items of a template (Menu.buildFromTemplate's work). */
	fill(template: MenuItemOptions[], toMenu: (items: MenuItemOptions[]) => Menu): void {
		for (const options of template) this.append(new MenuItem(options, this.#deps, toMenu));
	}

	popup(options: PopupOptions = {}): void {
		this.#popup(this, options);
	}

	closePopup(): void {}

	toWire(): Array<Record<string, unknown>> {
		return this.items.map(item => item.toWire());
	}

	findCommand(commandId: string): MenuItem | undefined {
		for (const item of this.items) {
			const found = item.find(commandId);
			if (found) return found;
		}
		return undefined;
	}
}

export class Tray extends EventEmitter {
	readonly #host: Host;
	readonly #id: number;
	readonly #menus: Map<number, Menu>;
	#menu: Menu | null = null;
	#destroyed = false;

	constructor(host: Host, menus: Map<number, Menu>, trays: Map<number, Tray>, image: NativeImage) {
		super();
		this.#host = host;
		this.#menus = menus;
		this.#id = host.nextTrayId();
		trays.set(this.#id, this);
		host.post("tray.create", {
			trayId: this.#id,
			images: image.representations(),
			template: image.isTemplateImage(),
			tooltip: "",
		});
	}

	get id(): number {
		return this.#id;
	}

	#op(op: string, args: Record<string, unknown> = {}): void {
		if (!this.#destroyed) this.#host.post("tray.op", { trayId: this.#id, op, args });
	}

	setToolTip(text: string): void {
		this.#op("setToolTip", { text });
	}

	setImage(image: NativeImage): void {
		this.#op("setImage", { images: image.representations(), template: image.isTemplateImage() });
	}

	setContextMenu(menu: Menu | null): void {
		if (this.#menu) this.#menus.delete(this.#menu.menuId);
		this.#menu = menu;
		if (menu) this.#menus.set(menu.menuId, menu);
		this.#op("setContextMenu", { menuId: menu?.menuId ?? 0, template: menu ? menu.toWire() : null });
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#op("destroy");
		this.#destroyed = true;
		if (this.#menu) this.#menus.delete(this.#menu.menuId);
		this.removeAllListeners();
	}

	isDestroyed(): boolean {
		return this.#destroyed;
	}
}

export function createMenuModule(host: Host, deps: MenuDeps) {
	const menus = new Map<number, Menu>();
	const trays = new Map<number, Tray>();
	let applicationMenu: Menu | null = null;

	const popup: PopupFn = (menu, options) => {
		const winId = options.window?.id ?? deps.focusedWindow()?.id;
		menus.set(menu.menuId, menu);
		host.client
			.call<{ itemId: string | null }>("menu.popup", {
				menuId: menu.menuId,
				template: menu.toWire(),
				winId,
				x: options.x,
				y: options.y,
			})
			.then(
				({ itemId }) => {
					menus.delete(menu.menuId);
					if (itemId) menu.findCommand(itemId)?.activate();
					options.callback?.();
				},
				(error: unknown) => {
					menus.delete(menu.menuId);
					host.warn(`menu.popup: ${String(error)}`);
				},
			);
	};

	const build = (template: MenuItemOptions[]): Menu => {
		const menu = new Menu(deps, popup);
		menu.menuId = host.nextMenuId();
		menu.fill(template, build);
		return menu;
	};

	host.client.on(
		"menu.click",
		({ menuId, itemId, checked }: { menuId: number; itemId: string; checked?: boolean }) => {
			menus.get(menuId)?.findCommand(itemId)?.activate(checked);
		},
	);
	host.client.on("menu.event", ({ menuId, name }: { menuId: number; name: "will-show" | "will-close" }) => {
		menus.get(menuId)?.emit(name === "will-show" ? "menu-will-show" : "menu-will-close", {});
	});
	host.client.on("tray.event", ({ trayId, name }: { trayId: number; name: string }) => {
		trays.get(trayId)?.emit(name, {}, {});
	});

	return {
		Menu: Object.assign(Menu, {
			buildFromTemplate: build,
			setApplicationMenu(menu: Menu | null): void {
				if (applicationMenu) menus.delete(applicationMenu.menuId);
				applicationMenu = menu;
				if (menu) menus.set(menu.menuId, menu);
				host.post("menu.setApplication", { menuId: menu?.menuId ?? 0, template: menu ? menu.toWire() : null });
			},
			getApplicationMenu: (): Menu | null => applicationMenu,
		}),
		MenuItem,
		Tray: class extends Tray {
			constructor(image: NativeImage) {
				super(host, menus, trays, image);
			}
		},
	};
}
