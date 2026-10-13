import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
	EMPTY_PREVIEW,
	isLoopbackUrl,
	type PreviewRequest,
	previewUrl,
	reducePreviewState,
} from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { latestBashPreviewUrl } from "../../lib/preview-browser";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, ErrorDetail, IconButton, Spinner } from "../common";

export function PreviewPanel() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const remote = useTabsStore(s => Boolean(s.tabs.find(tab => tab.id === (tabId ?? s.activeTabId))?.device));
	const requested = useUiStore(s => s.previewUrl);
	const latest = useToolsStore(latestBashPreviewUrl);
	const visible = useUiStore(s => s.panelVisible && s.panelTab === "preview" && s.destination === "session");
	const [state, dispatch] = useReducer(reducePreviewState, EMPTY_PREVIEW);
	const [input, setInput] = useState(requested ?? latest ?? "");
	const [invalid, setInvalid] = useState(false);
	const surface = useRef<HTMLDivElement>(null);
	const urlInput = useRef<HTMLInputElement>(null);
	const remoteBlocked = remote && isLoopbackUrl(input);
	const command = useCallback((request: PreviewRequest) => {
		void window.omp.preview.command(request).catch(error => dispatch({ loading: false, error: String(error) }));
	}, []);
	useEffect(() => window.omp.preview.onState(dispatch), []);
	const previousTab = useRef(tabId);
	const initialUrlChosen = useRef(false);
	const lastRequested = useRef<string | null>(null);
	useEffect(() => {
		if (previousTab.current !== tabId) {
			previousTab.current = tabId;
			command({ action: "dispose" });
			dispatch(EMPTY_PREVIEW);
			initialUrlChosen.current = false;
			lastRequested.current = null;
		}
		if (requested === lastRequested.current && initialUrlChosen.current) return;
		const url = requested ?? latest;
		if (!url) return;
		initialUrlChosen.current = true;
		lastRequested.current = requested;
		setInput(url);
		setInvalid(false);
		if (!(remote && isLoopbackUrl(url))) command({ action: "load", url });
	}, [requested, latest, remote, tabId, command]);
	useEffect(() => {
		if (state.url) setInput(state.url);
	}, [state.url]);
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const bounds = element.getBoundingClientRect();
				const covered = [
					...document.querySelectorAll(
						'.omp-dialog-overlay, [role="dialog"], [role="alertdialog"], [role="menu"], [data-state="open"][data-popover]',
					),
				].some(node => node.getClientRects().length > 0);
				command({
					action: "layout",
					bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
					visible: visible && !covered && !remoteBlocked && Boolean(state.url) && !state.error,
				});
			});
		};
		const resize = new ResizeObserver(update);
		resize.observe(element);
		const mutations = new MutationObserver(update);
		mutations.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["aria-hidden", "data-state", "style"],
		});
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		update();
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
			command({ action: "layout", bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
		};
	}, [visible, remoteBlocked, state.url, state.error, command]);
	useEffect(
		() => () => {
			void window.omp.preview.command({ action: "dispose" });
		},
		[],
	);
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-preview-panel>
			<form
				className="flex min-h-(--sc-space-10) min-w-0 shrink-0 items-center gap-1 border-b border-(--sc-divider) px-3 py-2"
				onSubmit={event => {
					event.preventDefault();
					const url = previewUrl(input);
					setInvalid(!url);
					if (url && !remoteBlocked) command({ action: "load", url });
				}}
			>
				<IconButton
					label={t("panel.preview.back")}
					icon={<ArrowLeft />}
					size="sm"
					disabled={!state.canGoBack || remoteBlocked}
					onClick={() => command({ action: "back" })}
				/>
				<IconButton
					label={t("panel.preview.forward")}
					icon={<ArrowRight />}
					size="sm"
					disabled={!state.canGoForward || remoteBlocked}
					onClick={() => command({ action: "forward" })}
				/>
				<IconButton
					label={t(state.loading ? "panel.preview.stop" : "panel.preview.reload")}
					icon={state.loading ? <Square /> : <RotateCw />}
					size="sm"
					disabled={!state.url || remoteBlocked}
					onClick={() => command({ action: state.loading ? "stop" : "reload" })}
				/>
				<input
					aria-label={t("panel.preview.url")}
					aria-invalid={invalid}
					ref={urlInput}
					inputMode="url"
					autoCapitalize="none"
					spellCheck={false}
					className="h-(--sc-control-sm) min-w-0 flex-1 rounded-(--sc-radius-sm) border border-(--sc-border) bg-(--sc-field) px-2 text-sc-sm text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
					value={input}
					placeholder="http://localhost:3000"
					onChange={event => {
						setInput(event.target.value);
						setInvalid(false);
					}}
				/>
				<IconButton
					label={t("panel.preview.load")}
					icon={<Globe />}
					size="sm"
					type="submit"
					disabled={remoteBlocked}
				/>
				<div className="flex shrink-0 items-center">
					<IconButton
						label={t("panel.preview.external")}
						icon={<ExternalLink />}
						size="sm"
						disabled={!previewUrl(input) || remoteBlocked}
						onClick={() => {
							const safe = previewUrl(input);
							if (safe) void window.omp.system.openExternal(safe);
						}}
					/>
				</div>
			</form>
			<div
				className="min-h-(--sc-space-6) truncate px-3 py-1 text-sc-xs text-(--sc-text-muted)"
				role="status"
				data-preview-status
				title={state.title}
			>
				{state.loading ? (
					<span className="flex items-center gap-1.5">
						<Spinner size="sm" />
						{t("panel.preview.loading")}
					</span>
				) : (
					state.title
				)}
			</div>
			{invalid && (
				<p role="alert" className="px-3 text-sc-sm text-(--sc-danger)">
					{t("panel.preview.invalid")}
				</p>
			)}
			<div ref={surface} className="relative min-h-0 flex-1" data-preview-surface>
				{remoteBlocked ? (
					<EmptyState icon={<Globe />} size="sm" title={t("panel.preview.remote")} />
				) : state.error ? (
					<div role="alert" className="p-4">
						<EmptyState
							icon={<Globe />}
							size="sm"
							title={t("panel.preview.failed")}
							actions={
								<Button size="sm" variant="secondary" onClick={() => command({ action: "reload" })}>
									{t("common.retry")}
								</Button>
							}
						/>
						<ErrorDetail className="break-words" error={state.error} />
					</div>
				) : !state.url ? (
					<EmptyState
						icon={<Globe />}
						size="sm"
						title={t("panel.preview.empty")}
						actions={
							<Button size="sm" variant="secondary" onClick={() => urlInput.current?.focus()}>
								{t("panel.preview.enterUrl")}
							</Button>
						}
					/>
				) : null}
			</div>
		</div>
	);
}
