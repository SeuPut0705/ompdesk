import type { ITheme, Terminal } from "@xterm/xterm";
import { ClipboardPaste, Copy, Plus, RotateCw, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalOperation, TerminalSnapshot } from "../../../shared/terminal-types";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { Banner, Button, EmptyState, ErrorDetail, IconButton, Spinner } from "../common";
import "@xterm/xterm/css/xterm.css";

export function terminalTheme(element: HTMLElement): ITheme {
	const style = getComputedStyle(element);
	const color = (name: string) => style.getPropertyValue(`--sc-${name}`).trim();
	return {
		background: color("surface-1"),
		foreground: color("text"),
		cursor: color("text"),
		selectionBackground: color("selection"),
		black: color("text-subtle"),
		brightBlack: color("text-muted"),
		red: color("danger"),
		brightRed: color("danger"),
		green: color("success"),
		brightGreen: color("success"),
		yellow: color("warning"),
		brightYellow: color("warning"),
		blue: color("info"),
		brightBlue: color("info"),
		magenta: color("accent"),
		brightMagenta: color("accent"),
		cyan: color("info"),
		brightCyan: color("info"),
		white: color("text"),
		brightWhite: color("text"),
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
	>;
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
}: {
	tabId: string;
	id: string;
	onStatus: (snapshot: TerminalSnapshot) => void;
	onError: (error: string) => void;
	mount?: (element: HTMLElement) => TerminalMount | Promise<TerminalMount>;
	handle: { current: TerminalMount | null };
}) {
	const element = useRef<HTMLDivElement>(null);
	const t = useT();
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
			const input = view.terminal.onData(data => {
				void request({ action: "write", id, data });
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
			const resize = () => {
				if (!element.current || element.current.clientWidth === 0 || element.current.clientHeight === 0) return;
				view.fit();
				void request({ action: "resize", id, cols: view.terminal.cols, rows: view.terminal.rows });
			};
			const observer = new ResizeObserver(resize);
			observer.observe(target);
			const theme = new MutationObserver(() => {
				if (element.current) view.terminal.options.theme = terminalTheme(element.current);
			});
			theme.observe(document.documentElement, { attributes: true });
			resize();
			view.terminal.focus();
			const poll = async () => {
				const snapshots = await request({ action: "list", offsets: { [id]: offset } });
				if (stopped) return;
				const snapshot = snapshots?.find(item => item.id === id);
				if (snapshot) {
					if (snapshot.output) view.terminal.write(snapshot.output);
					offset = snapshot.offset;
					onStatus(snapshot);
				}
				if (snapshots) timer = setTimeout(() => void poll(), 80);
			};
			void poll();
			cleanup = () => {
				clearTimeout(timer);
				observer.disconnect();
				theme.disconnect();
				input.dispose();
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
	}, [tabId, id, mount, onStatus, onError, handle]);
	return (
		<div
			aria-label={t("panel.terminal.title")}
			className="min-h-0 min-w-0 flex-1 overflow-hidden p-2"
			data-terminal-viewport
			ref={element}
		/>
	);
}

function LocalTerminalPanel({ tabId }: { tabId: string }) {
	const t = useT();
	const [sessions, setSessions] = useState<TerminalSnapshot[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const handle = useRef<TerminalMount | null>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
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
			if (result?.length === 0) result = await request({ action: "create", cols: 80, rows: 24 });
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
	const active = sessions.find(session => session.id === selected);
	const add = async () => {
		const result = await request({ action: "create", cols: 80, rows: 24 });
		if (result) setSelected(result.at(-1)?.id ?? null);
	};
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
			<div className="flex min-h-(--sc-space-10) min-w-0 shrink-0 items-center gap-1 border-b border-(--sc-divider) px-3 py-2">
				<div
					className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
					ref={tabsRef}
					role="tablist"
					aria-label={t("panel.terminal.title")}
				>
					{sessions.map((session, index) => (
						<div className="flex shrink-0 items-center" key={session.id}>
							<button
								type="button"
								role="tab"
								aria-selected={session.id === selected}
								title={t("panel.terminal.session", { number: index + 1 })}
								className="min-h-(--sc-control-sm) max-w-40 truncate rounded-(--sc-radius-sm) px-2 py-1 text-sc-xs text-(--sc-text-muted) transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) hover:text-(--sc-text) active:bg-(--sc-pressed) aria-selected:bg-(--sc-selected) aria-selected:text-(--sc-text) motion-reduce:transition-none"
								onClick={() => setSelected(session.id)}
							>
								{t("panel.terminal.session", { number: index + 1 })}
							</button>
							<IconButton
								icon={<X />}
								label={t("panel.terminal.close")}
								onClick={() => void close(session.id)}
								size="sm"
							/>
						</div>
					))}
				</div>
				<IconButton
					icon={<Plus />}
					label={t("panel.terminal.new")}
					disabled={loading}
					onClick={() => void add()}
					size="sm"
				/>
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
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
			{loading ? (
				<Spinner className="p-3" label={t("panel.terminal.starting")} size="sm" />
			) : selected ? (
				<TerminalViewport
					handle={handle}
					id={selected}
					key={`${selected}:${attempt}`}
					onError={setError}
					onStatus={onStatus}
					tabId={tabId}
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
	const remote = useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.device);
	if (!tabId || remote)
		return (
			<EmptyState
				icon={<TerminalIcon />}
				size="sm"
				title={t(remote ? "panel.terminal.localOnly" : "panel.terminal.noTab")}
			/>
		);
	return <LocalTerminalPanel key={tabId} tabId={tabId} />;
}
