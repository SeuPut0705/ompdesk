import type { ITheme, Terminal } from "@xterm/xterm";
import {
	ChevronDown,
	ClipboardPaste,
	Copy,
	Keyboard,
	Maximize2,
	Minimize2,
	Plus,
	RotateCw,
	Terminal as TerminalIcon,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	TERMINAL_SHELL_PREF,
	type TerminalLeaseState,
	type TerminalOperation,
	type TerminalShell,
	type TerminalSnapshot,
} from "../../../shared/terminal-types";
import { currentShellMode, useCompactShell, useShellInput } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { rovingIndex } from "../../lib/roving";
import {
	applyModifiers,
	clampFontScale,
	FONT_SCALE_DEFAULT,
	FONT_SCALE_STEP,
	fontSizeFor,
	type HeldModifiers,
	isSingleKey,
	type TerminalKey,
} from "../../lib/terminal-keys";
import { TerminalLocalEcho } from "../../lib/terminal-local-echo";
import { pollTerminal } from "../../lib/terminal-poll";
import { chromePlatform } from "../../lib/window-chrome";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, EmptyState, ErrorDetail, IconButton, MenuButton, Spinner } from "../common";
import { TerminalKeyBar } from "./TerminalKeyBar";
import "@xterm/xterm/css/xterm.css";

const FONT_SCALE_KEY = "omp.terminalFontScale";

function readFontScale(): number {
	try {
		const stored = Number(window.localStorage.getItem(FONT_SCALE_KEY));
		return stored > 0 ? clampFontScale(stored) : FONT_SCALE_DEFAULT;
	} catch {
		return FONT_SCALE_DEFAULT;
	}
}

/** xterm's palette for the page's theme: the surface, the text, the selection and the theme's own ANSI 16 (`--omp-ansi-*`). */
export function terminalTheme(element: HTMLElement): ITheme {
	const style = getComputedStyle(element);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const color = (name: string) => read(`--sc-${name}`);
	const ansi = (name: string) => read(`--omp-ansi-${name}`);
	return {
		background: color("surface-1"),
		foreground: color("text"),
		cursor: color("text"),
		cursorAccent: color("surface-1"),
		selectionBackground: read("--omp-selection-bg"),
		black: ansi("black"),
		red: ansi("red"),
		green: ansi("green"),
		yellow: ansi("yellow"),
		blue: ansi("blue"),
		magenta: ansi("magenta"),
		cyan: ansi("cyan"),
		white: ansi("white"),
		brightBlack: ansi("bright-black"),
		brightRed: ansi("bright-red"),
		brightGreen: ansi("bright-green"),
		brightYellow: ansi("bright-yellow"),
		brightBlue: ansi("bright-blue"),
		brightMagenta: ansi("bright-magenta"),
		brightCyan: ansi("bright-cyan"),
		brightWhite: ansi("bright-white"),
	};
}

export interface TerminalMount {
	terminal: Pick<
		Terminal,
		| "cols"
		| "rows"
		| "options"
		| "write"
		| "onData"
		| "focus"
		| "clear"
		| "getSelection"
		| "dispose"
		| "attachCustomKeyEventHandler"
	> &
		/** xterm always has them; a test double without one never paints predictions or draws another viewer's size. */
		Partial<Pick<Terminal, "buffer" | "resize">>;
	fit(): void;
}
export async function mountTerminal(element: HTMLElement): Promise<TerminalMount> {
	// Browser-only UMD modules require `self`; keep them out of Node/linkedom import paths.
	const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
	const terminal = new Terminal({
		cursorBlink: true,
		fontSize: 12,
		fontFamily: "monospace",
		scrollback: 10000,
		theme: terminalTheme(element),
		allowProposedApi: false,
	});
	const fit = new FitAddon();
	terminal.loadAddon(fit);
	terminal.open(element);
	return { terminal, fit: () => fit.fit() };
}

export function TerminalViewport({
	tabId,
	id,
	onStatus,
	onError,
	mount = mountTerminal,
	handle,
	predict = false,
	transform,
	fontSize,
	onLease,
	claimTick = 0,
	takeFocus = true,
}: {
	tabId: string;
	id: string;
	onStatus: (snapshot: TerminalSnapshot) => void;
	onError: (error: string) => void;
	mount?: (element: HTMLElement) => TerminalMount | Promise<TerminalMount>;
	handle: { current: TerminalMount | null };
	/** Paint typed characters before the host echoes them (a paired host's tab, C109). */
	predict?: boolean;
	/** What typed data becomes before it is written (the key bar's sticky Ctrl and Alt). */
	transform?: (data: string) => string;
	/** The terminal's font size in px; changing it refits the screen. */
	fontSize?: number;
	/** Focus the shell once it is up; false when the arrow keys switched sessions and focus stays on the tabs. */
	takeFocus?: boolean;
	/** Who sizes the PTY changed (`other`: another viewer does, this one draws the PTY at its size). */
	onLease?: (lease: TerminalLeaseState | undefined) => void;
	/** Bumped after this viewer took the PTY's size (`claim`): it fits and resizes again. */
	claimTick?: number;
}) {
	const element = useRef<HTMLDivElement>(null);
	const t = useT();
	// The running effect's own pieces, for the effects below that react to a prop without restarting it.
	const refit = useRef<(() => void) | null>(null);
	/** This viewer sizes the PTY (the screen fits its box); otherwise it draws another viewer's size and scrolls. */
	const [sized, setSized] = useState(true);
	const fontChanged = useRef<(() => void) | null>(null);
	const latest = useRef({ transform, fontSize, onLease, takeFocus });
	latest.current = { transform, fontSize, onLease, takeFocus };
	useEffect(() => {
		if (!element.current) return;
		const target = element.current;
		let stopped = false;
		let cleanup = () => {};
		void (async () => {
			const view = await mount(target);
			if (stopped) {
				view.terminal.dispose();
				return;
			}
			handle.current = view;
			let offset = 0;
			let timer: NodeJS.Timeout;
			const request = async (operation: TerminalOperation) => {
				try {
					return await window.omp.terminal.request(tabId, operation);
				} catch (error) {
					if (!stopped) onError(error instanceof Error ? error.message : String(error));
					return null;
				}
			};
			const echo = predict
				? new TerminalLocalEcho({
						write: data => view.terminal.write(data),
						anchor: () => {
							const buffer = view.terminal.buffer?.active;
							if (buffer?.type !== "normal") return null;
							const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
							return line.length <= buffer.cursorX ? buffer.cursorX : null;
						},
						cols: () => view.terminal.cols,
					})
				: null;
			const input = view.terminal.onData(data => {
				echo?.input(data);
				void request({ action: "write", id, data: latest.current.transform?.(data) ?? data });
			});
			view.terminal.attachCustomKeyEventHandler(event => {
				if (event.type !== "keydown") return true;
				const copy =
					(event.metaKey && event.key === "c") ||
					(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c");
				const paste =
					(event.metaKey && event.key === "v") ||
					(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v");
				if (copy) {
					void navigator.clipboard.writeText(view.terminal.getSelection()).catch(error => onError(String(error)));
					return false;
				}
				if (paste) {
					void navigator.clipboard
						.readText()
						.then(data => request({ action: "write", id, data }))
						.catch(error => onError(String(error)));
					return false;
				}
				return true;
			});
			// Who sizes the PTY (lease.ts): while another viewer does, this one draws the PTY at that size and
			// neither fits to its own box nor asks for a resize.
			let lease: TerminalLeaseState | undefined;
			const resize = () => {
				if (lease === "other") return;
				if (!element.current || element.current.clientWidth === 0 || element.current.clientHeight === 0) return;
				view.fit();
				void request({ action: "resize", id, cols: view.terminal.cols, rows: view.terminal.rows });
			};
			const onSnapshot = (snapshot: TerminalSnapshot) => {
				if (snapshot.lease !== lease) {
					lease = snapshot.lease;
					setSized(lease !== "other");
					latest.current.onLease?.(lease);
					if (lease !== "other") resize();
				}
				if (
					lease === "other" &&
					snapshot.cols &&
					snapshot.rows &&
					(snapshot.cols !== view.terminal.cols || snapshot.rows !== view.terminal.rows)
				)
					view.terminal.resize?.(snapshot.cols, snapshot.rows);
				onStatus(snapshot);
			};
			const applyFontSize = () => {
				const size = latest.current.fontSize;
				if (size === undefined || view.terminal.options.fontSize === size) return;
				view.terminal.options.fontSize = size;
				resize();
			};
			refit.current = () => {
				// A claim answers `you` on the next snapshot; fit now so the screen does not wait for it.
				lease = "you";
				setSized(true);
				applyFontSize();
				resize();
			};
			// Fitting resizes xterm's own DOM inside the observed box (and a scrollbar may appear): done in the
			// observer's callback WebKit reports that as a ResizeObserver loop error, so it runs a tick later.
			let fitTimer: ReturnType<typeof setTimeout> | undefined;
			const observer = new ResizeObserver(() => {
				clearTimeout(fitTimer);
				fitTimer = setTimeout(resize, 0);
			});
			observer.observe(target);
			const theme = new MutationObserver(() => {
				if (element.current) view.terminal.options.theme = terminalTheme(element.current);
			});
			theme.observe(document.documentElement, { attributes: true });
			applyFontSize();
			resize();
			if (latest.current.takeFocus) view.terminal.focus();
			// A new font size arrives through `latest`; the effect below calls this.
			fontChanged.current = applyFontSize;
			if (chromePlatform() === "web") {
				// A phone asks once and the host holds the answer until the PTY writes; the next request is the
				// acknowledgement of the last output (terminal-poll.ts).
				void pollTerminal({
					id,
					request,
					write: output =>
						new Promise<void>(done => view.terminal.write(echo ? echo.output(output) : output, done)),
					onSnapshot,
					stopped: () => stopped,
				});
			} else {
				const poll = async () => {
					const snapshots = await request({ action: "list", offsets: { [id]: offset } });
					if (stopped) return;
					const snapshot = snapshots?.find(item => item.id === id);
					if (snapshot) {
						if (snapshot.output) view.terminal.write(echo ? echo.output(snapshot.output) : snapshot.output);
						offset = snapshot.offset;
						onSnapshot(snapshot);
					}
					if (snapshots) timer = setTimeout(() => void poll(), 80);
				};
				void poll();
			}
			cleanup = () => {
				clearTimeout(timer);
				refit.current = null;
				fontChanged.current = null;
				clearTimeout(fitTimer);
				observer.disconnect();
				theme.disconnect();
				input.dispose();
				echo?.dispose();
				view.terminal.dispose();
				if (handle.current === view) handle.current = null;
			};
		})().catch(error => {
			if (!stopped) onError(String(error));
		});
		return () => {
			stopped = true;
			cleanup();
		};
	}, [tabId, id, mount, onStatus, onError, handle, predict]);
	useEffect(() => {
		if (fontSize !== undefined) fontChanged.current?.();
	}, [fontSize]);
	useEffect(() => {
		if (claimTick > 0) refit.current?.();
	}, [claimTick]);
	return (
		<div
			aria-label={t("panel.terminal.title")}
			className={`min-h-0 min-w-0 flex-1 p-2 ${sized ? "overflow-hidden" : "overflow-auto"}`}
			data-terminal-viewport
			ref={element}
		/>
	);
}

function TabTerminalPanel({ tabId }: { tabId: string }) {
	const t = useT();
	const [sessions, setSessions] = useState<TerminalSnapshot[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const handle = useRef<TerminalMount | null>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	/** The arrow keys switched sessions: the new shell leaves focus on the tab, so the next arrow moves on. */
	const keyboardSwitch = useRef(false);
	const [shells, setShells] = useState<TerminalShell[]>([]);
	const expanded = useUiStore(s => s.terminalExpanded);
	const compact = useCompactShell();
	// A paired host's terminal answers over the network: typed characters are predicted (C109).
	const remote = useTabsStore(state => state.tabs.some(tab => tab.id === tabId && tab.device !== undefined));
	// A phone's key bar (Esc, Tab, sticky Ctrl/Alt, arrows, symbols) and its text size, 50–200 %.
	const touch = useShellInput() === "touch";
	const [keysOpen, setKeysOpen] = useState(() => currentShellMode() === "phone");
	const [fontScale, setFontScale] = useState(readFontScale);
	const [held, setHeld] = useState<HeldModifiers>({ ctrl: false, alt: false });
	const heldRef = useRef(held);
	heldRef.current = held;
	/** Another viewer sizes the active PTY (lease.ts): this screen draws it at that size until it claims. */
	const [lease, setLease] = useState<TerminalLeaseState | undefined>();
	const [claimTick, setClaimTick] = useState(0);
	const changeFont = (change: "smaller" | "larger" | "reset") => {
		const next = clampFontScale(
			change === "reset" ? FONT_SCALE_DEFAULT : fontScale + (change === "larger" ? 1 : -1) * FONT_SCALE_STEP,
		);
		setFontScale(next);
		try {
			window.localStorage.setItem(FONT_SCALE_KEY, String(next));
		} catch {
			// Storage may be blocked (private mode); the size still applies until the page closes.
		}
	};
	/** Typed data with the held Ctrl/Alt applied; a single key spends them. */
	const transform = useCallback((data: string) => {
		const mods = heldRef.current;
		if (!mods.ctrl && !mods.alt) return data;
		if (isSingleKey(data)) {
			heldRef.current = { ctrl: false, alt: false };
			setHeld(heldRef.current);
		}
		return applyModifiers(data, mods);
	}, []);
	useEffect(() => {
		let live = true;
		void window.omp.terminal.shells(tabId).then(
			found => {
				if (live) setShells(found);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [tabId]);
	useLayoutEffect(() => {
		if (!selected) return;
		tabsRef.current
			?.querySelector<HTMLElement>('[aria-selected="true"]')
			?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
	}, [selected]);
	const request = useCallback(
		async (operation: TerminalOperation) => {
			try {
				const result = await window.omp.terminal.request(tabId, operation);
				setSessions(result);
				setError(null);
				return result;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return null;
			}
		},
		[tabId],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries worker startup.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void (async () => {
			let result = await request({ action: "list", offsets: {} });
			if (cancelled) return;
			if (result?.length === 0) {
				// Settings › General › Terminal shell; main ignores a path it no longer finds.
				const preferred = await window.omp.prefs.get(TERMINAL_SHELL_PREF).catch(() => undefined);
				if (cancelled) return;
				result = await request({
					action: "create",
					cols: 80,
					rows: 24,
					...(typeof preferred === "string" && preferred ? { shell: preferred } : {}),
				});
			}
			if (cancelled) return;
			setSelected(result?.[0]?.id ?? null);
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [request, attempt]);
	const onStatus = useCallback((snapshot: TerminalSnapshot) => {
		setSessions(previous => {
			const current = previous.find(item => item.id === snapshot.id);
			if (
				current?.exited === snapshot.exited &&
				current?.error === snapshot.error &&
				current?.exitCode === snapshot.exitCode
			)
				return previous;
			return previous.map(item => (item.id === snapshot.id ? { ...snapshot, output: "" } : item));
		});
	}, []);
	// "Run in terminal" and /cleanse wrote to this session: show it once it is listed.
	const focusId = useUiStore(s => s.terminalFocusId);
	useEffect(() => {
		if (!focusId || !sessions.some(session => session.id === focusId)) return;
		setSelected(focusId);
		useUiStore.setState({ terminalFocusId: null });
	}, [focusId, sessions]);
	const active = sessions.find(session => session.id === selected);
	const add = async (shell?: string) => {
		const preferred = shell ?? (await window.omp.prefs.get(TERMINAL_SHELL_PREF).catch(() => undefined));
		const result = await request({
			action: "create",
			cols: 80,
			rows: 24,
			...(typeof preferred === "string" && preferred ? { shell: preferred } : {}),
		});
		if (!result) return;
		keyboardSwitch.current = false;
		setSelected(result.at(-1)?.id ?? null);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: a session just chosen starts with nobody known to hold its size.
	useEffect(() => setLease(undefined), [selected]);
	const sendKey = (key: TerminalKey) => {
		if (key.data === undefined || !selected) return;
		void request({ action: "write", id: selected, data: transform(key.data) });
	};
	const claim = async () => {
		if (!selected) return;
		if (await request({ action: "claim", id: selected })) {
			setLease("you");
			setClaimTick(tick => tick + 1);
		}
	};
	const selectedIndex = sessions.findIndex(session => session.id === (selected ?? sessions[0]?.id));
	const close = async (id: string) => {
		const result = await request({ action: "close", id });
		if (result && id === selected) setSelected(result[0]?.id ?? null);
	};
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(handle.current?.terminal.getSelection() ?? "");
		} catch (cause) {
			setError(String(cause));
		}
	};
	const paste = async () => {
		try {
			if (selected) await request({ action: "write", id: selected, data: await navigator.clipboard.readText() });
		} catch (cause) {
			setError(String(cause));
		}
	};
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--sc-surface-1)">
			<div
				className={cx(
					"flex min-h-(--sc-space-10) min-w-0 shrink-0 items-center border-b border-(--sc-divider) px-3 py-2",
					touch ? "gap-2.5 [--hit-gap-x:10px]" : "gap-1",
				)}
				data-terminal-head
			>
				<div
					className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
					ref={tabsRef}
					role="tablist"
					aria-label={t("panel.terminal.title")}
					onKeyDown={event => {
						const at = sessions.findIndex(session => session.id === selected);
						// A tab list holds only tabs: the close buttons beside them are for the pointer, Delete closes the
						// focused one (the APG's closable tabs) and assistive tech has the selected one's close after the list.
						if (event.key === "Delete" && at !== -1) {
							event.preventDefault();
							void close(sessions[at]?.id ?? "");
							return;
						}
						const next = rovingIndex(event.key, at, sessions.length);
						if (next === null) return;
						event.preventDefault();
						const id = sessions[next]?.id;
						if (!id) return;
						keyboardSwitch.current = true;
						setSelected(id);
						tabsRef.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
					}}
				>
					{sessions.map((session, index) => (
						<div className="flex shrink-0 items-center" key={session.id}>
							<button
								type="button"
								role="tab"
								aria-keyshortcuts="Delete"
								aria-selected={session.id === selected}
								tabIndex={session.id === (selected ?? sessions[0]?.id) ? 0 : -1}
								title={t("panel.terminal.session", { number: index + 1 })}
								className="min-h-(--sc-control-sm) max-w-40 truncate rounded-(--sc-radius-sm) px-2 py-1 text-sc-xs text-(--sc-text-muted) transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) hover:text-(--sc-text) active:bg-(--sc-pressed) aria-selected:bg-(--sc-selected) aria-selected:text-(--sc-text) motion-reduce:transition-none"
								onClick={() => {
									keyboardSwitch.current = false;
									setSelected(session.id);
								}}
							>
								{t("panel.terminal.session", { number: index + 1 })}
							</button>
							<IconButton
								aria-hidden
								icon={<X />}
								label={t("panel.terminal.closeFor", { number: index + 1 })}
								onClick={() => void close(session.id)}
								size="sm"
								tabIndex={-1}
							/>
						</div>
					))}
				</div>
				{/* The tab list holds only tabs, so the close buttons beside them are the pointer's. The selected session's
				    close lives here for assistive tech (a touch screen reader has no Delete key); sighted keyboard users
				    see it when it takes focus. */}
				{selectedIndex !== -1 && (
					<IconButton
						className="sr-only focus-visible:not-sr-only"
						data-terminal-close-selected
						icon={<X />}
						label={t("panel.terminal.closeFor", { number: selectedIndex + 1 })}
						onClick={() => void close(sessions[selectedIndex]?.id ?? "")}
						size="sm"
					/>
				)}
				<IconButton
					icon={<Plus />}
					label={t("panel.terminal.new")}
					disabled={loading}
					onClick={() => void add()}
					size="sm"
				/>
				{shells.length > 1 && (
					<MenuButton
						disabled={loading}
						icon={<ChevronDown />}
						items={shells.map(shell => ({
							id: shell.path,
							label: t("panel.terminal.newWith", { name: shell.name }),
							description: shell.path,
							onSelect: () => void add(shell.path),
						}))}
						label={t("panel.terminal.newWithMenu")}
						size="sm"
					/>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					{touch && (
						<IconButton
							data-terminal-keys-toggle
							icon={<Keyboard />}
							label={t(keysOpen ? "panel.terminal.keysHide" : "panel.terminal.keysShow")}
							onClick={() => setKeysOpen(open => !open)}
							pressed={keysOpen}
							size="sm"
						/>
					)}
					<IconButton
						icon={<Copy />}
						label={t("panel.terminal.copy")}
						disabled={!selected}
						onClick={() => void copy()}
						size="sm"
					/>
					<IconButton
						icon={<ClipboardPaste />}
						label={t("panel.terminal.paste")}
						disabled={!selected || active?.exited}
						onClick={() => void paste()}
						size="sm"
					/>
					<IconButton
						icon={<Trash2 />}
						label={t("panel.terminal.clear")}
						disabled={!selected}
						onClick={() => {
							if (selected) {
								const view = handle.current;
								void request({ action: "clear", id: selected }).then(result => {
									if (!result || handle.current !== view) return;
									view?.terminal.clear();
									view?.terminal.write("\u001b[2J\u001b[3J\u001b[H");
								});
							}
						}}
						size="sm"
					/>
					{!compact && (
						<IconButton
							icon={expanded ? <Minimize2 /> : <Maximize2 />}
							label={t(expanded ? "fileViewer.collapse" : "fileViewer.expand")}
							onClick={() => useUiStore.setState({ terminalExpanded: !expanded })}
							pressed={expanded}
							size="sm"
						/>
					)}
				</div>
			</div>
			{error && (
				<Banner
					actions={
						<Button
							icon={<RotateCw />}
							onClick={() => setAttempt(value => value + 1)}
							size="sm"
							variant="secondary"
						>
							{t("common.retry")}
						</Button>
					}
					className="mx-3 mt-3"
					live
					title={t("panel.terminal.failed")}
					variant="danger"
				>
					<ErrorDetail error={error} />
				</Banner>
			)}
			{lease === "other" && (
				<div data-terminal-lease>
					<Banner
						actions={
							<Button data-terminal-lease-claim onClick={() => void claim()} size="sm" variant="secondary">
								{t("panel.terminal.lease.claim")}
							</Button>
						}
						className="mx-3 mt-3"
						live
					>
						{t("panel.terminal.lease.other")}
					</Banner>
				</div>
			)}
			{loading ? (
				<Spinner className="p-3" label={t("panel.terminal.starting")} size="sm" />
			) : selected ? (
				<TerminalViewport
					claimTick={claimTick}
					fontSize={fontSizeFor(fontScale)}
					handle={handle}
					id={selected}
					key={`${selected}:${attempt}`}
					onError={setError}
					onLease={setLease}
					onStatus={onStatus}
					predict={remote}
					tabId={tabId}
					takeFocus={!keyboardSwitch.current}
					transform={transform}
				/>
			) : (
				<EmptyState
					icon={<TerminalIcon />}
					size="sm"
					title={t("panel.terminal.empty")}
					actions={
						<Button icon={<Plus />} onClick={() => void add()} size="sm" variant="secondary">
							{t("panel.terminal.new")}
						</Button>
					}
				/>
			)}
			{touch && keysOpen && selected && !loading && (
				<TerminalKeyBar
					disabled={Boolean(active?.exited)}
					fontScale={fontScale}
					held={held}
					onFontScale={changeFont}
					onKey={sendKey}
					onModifier={modifier => setHeld(previous => ({ ...previous, [modifier]: !previous[modifier] }))}
				/>
			)}
			{active?.exited && (
				<div
					role="status"
					className="flex min-w-0 shrink-0 items-start justify-between gap-2 border-t border-(--sc-border) px-3 py-2 text-sc-xs text-(--sc-text-muted)"
				>
					<span className="min-w-0 flex-1 break-words">
						{active.error || t("panel.terminal.exited", { code: active.exitCode ?? "—" })}
					</span>
					<Button
						icon={<RotateCw />}
						onClick={() => {
							if (selected) void request({ action: "restart", id: selected });
						}}
						size="sm"
					>
						{t("panel.terminal.restart")}
					</Button>
				</div>
			)}
		</div>
	);
}
export function TerminalPanel() {
	const t = useT();
	const tabId = useTabsStore(state => state.activeTabId);
	// A paired host's tab gets the host's terminals, in the tab's folder there (C114).
	if (!tabId) return <EmptyState icon={<TerminalIcon />} size="sm" title={t("panel.terminal.noTab")} />;
	return <TabTerminalPanel key={tabId} tabId={tabId} />;
}
