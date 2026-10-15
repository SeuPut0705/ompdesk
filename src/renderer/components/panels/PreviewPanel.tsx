import {
	AlertTriangle,
	ArrowLeft,
	ArrowRight,
	Bot,
	ExternalLink,
	FileDown,
	GalleryVerticalEnd,
	Globe,
	Laptop,
	Maximize,
	MoreHorizontal,
	MousePointerClick,
	Plus,
	RotateCw,
	SlidersHorizontal,
	Smartphone,
	Square,
	SquareDashed,
	Tablet,
	X,
	XCircle,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
	clampPreviewZoom,
	EMPTY_PREVIEW,
	isLoopbackUrl,
	PREVIEW_PROBLEM_LIMIT,
	PREVIEW_TAB_LIMIT,
	PREVIEW_VIEWPORTS,
	PREVIEW_ZOOM_MAX,
	PREVIEW_ZOOM_MIN,
	type PreviewRequest,
	type PreviewViewport,
	previewAddress,
	previewProblemCount,
	reducePreviewState,
} from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { latestBashPreviewUrl } from "../../lib/preview-browser";
import { usePreviewVisualsStore } from "../../stores/preview-visuals";
import { sessionRuntime, useRuntimeTabId, useSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import {
	Banner,
	Button,
	type ContextMenuItem,
	CopyButton,
	EmptyState,
	ErrorDetail,
	IconButton,
	MenuButton,
	Popover,
	Spinner,
} from "../common";
import { AllVisualsDialog, PreviewFeedbackBar, usePreviewFeedback } from "./PreviewFeedback";

const VIEWPORT_ICONS = { fill: Maximize, phone: Smartphone, tablet: Tablet, laptop: Laptop } as const;

/** Stop `tabId`'s relay so its browser tool falls back to its configured browser (best effort: the tab may be gone). */
function releaseAgentRelay(tabId: string): void {
	void sessionRuntime(tabId)
		?.command({ type: "browser_relay_stop" })
		.catch(() => {});
}
export function PreviewPanel() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const runtime = useSessionRuntime();
	const remote = useTabsStore(s => Boolean(s.tabs.find(tab => tab.id === (tabId ?? s.activeTabId))?.device));
	const requested = useUiStore(s => s.previewUrl);
	const latest = useToolsStore(latestBashPreviewUrl);
	const visible = useUiStore(s => s.panelVisible && s.panelTab === "preview" && s.destination === "session");
	const [state, dispatch] = useReducer(reducePreviewState, EMPTY_PREVIEW);
	const [input, setInput] = useState(requested ?? latest ?? "");
	const [invalid, setInvalid] = useState(false);
	const surface = useRef<HTMLDivElement>(null);
	const urlInput = useRef<HTMLInputElement>(null);
	const address = previewAddress(input);
	const remoteBlocked = remote && isLoopbackUrl(address ?? "");
	const [problemsOpen, setProblemsOpen] = useState(false);
	const problemsAnchor = useRef<HTMLButtonElement>(null);
	const [agentStarting, setAgentStarting] = useState(false);
	const command = useCallback((request: PreviewRequest) => {
		void window.omp.preview.command(request).catch(error => dispatch({ loading: false, error: String(error) }));
	}, []);
	const agentTab = useRef<string | null>(null);
	agentTab.current = state.agent?.tabId ?? null;
	/** Take the page back from the agent: close its connection here, then stop its tab's relay. */
	const takeOver = useCallback(() => {
		const owner = agentTab.current;
		void window.omp.preview.command({ action: "agentStop" }).catch(() => {});
		if (owner) releaseAgentRelay(owner);
	}, []);
	const letAgentIn = async () => {
		if (!tabId || !runtime || remote) return;
		setAgentStarting(true);
		try {
			const response = await runtime.command({ type: "browser_relay_start" });
			if (!response.success) throw new Error(response.error ?? "browser_relay_start failed");
			const relay: unknown = response.data;
			if (
				!relay ||
				typeof relay !== "object" ||
				!("url" in relay) ||
				typeof relay.url !== "string" ||
				!("token" in relay) ||
				typeof relay.token !== "string"
			) {
				throw new Error("omp returned no browser relay endpoint");
			}
			await window.omp.preview.command({ action: "agentStart", tabId, url: relay.url, token: relay.token });
		} catch (error) {
			releaseAgentRelay(tabId);
			toastError({ title: t("panel.preview.agent.failed"), error });
		} finally {
			setAgentStarting(false);
		}
	};
	useEffect(() => window.omp.preview.onState(dispatch), []);
	const previousTab = useRef(tabId);
	const initialUrlChosen = useRef(false);
	const lastRequested = useRef<string | null>(null);
	useEffect(() => {
		if (previousTab.current !== tabId) {
			previousTab.current = tabId;
			// Disposing the page ends any agent's hold on it; its tab's relay goes too.
			if (agentTab.current) releaseAgentRelay(agentTab.current);
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
	// C135: the tab's visuals come back as preview tabs (the first one shown when no address was asked for),
	// and the ones the agent shows while this panel is up open at once.
	const startUrl = useRef(false);
	startUrl.current = Boolean(requested ?? latest);
	useEffect(() => {
		if (tabId && !remote) command({ action: "restoreVisuals", tabId, show: !startUrl.current });
	}, [tabId, remote, command]);
	const pendingVisuals = usePreviewVisualsStore(s => (tabId ? s.pending[tabId] : undefined));
	useEffect(() => {
		if (!tabId || remote || !pendingVisuals?.length) return;
		for (const visualId of usePreviewVisualsStore.getState().take(tabId))
			command({ action: "showVisual", tabId, visualId });
	}, [pendingVisuals, tabId, remote, command]);
	const feedback = usePreviewFeedback(state, tabId);
	const [allVisualsOpen, setAllVisualsOpen] = useState(false);
	// Show the shown tab's address: on a tab switch even an empty one, otherwise as the page navigates.
	const shownTab = useRef("");
	useEffect(() => {
		const switched = shownTab.current !== "" && shownTab.current !== state.activeTab;
		shownTab.current = state.activeTab;
		if (switched || state.url) {
			setInput(state.url);
			setInvalid(false);
		}
	}, [state.url, state.activeTab]);
	// Main lets go of the agent when another preview tab is shown or its page closes; stop that tab's relay too.
	const agentOwner = useRef<string | null>(null);
	useEffect(() => {
		const owner = state.agent?.tabId ?? null;
		if (agentOwner.current && !owner) releaseAgentRelay(agentOwner.current);
		agentOwner.current = owner;
	}, [state.agent?.tabId]);
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
					visible: visible && !covered && !remoteBlocked && Boolean(state.url) && !state.error && !state.crashed,
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
	}, [visible, remoteBlocked, state.url, state.error, state.crashed, command]);
	useEffect(
		() => () => {
			if (agentTab.current) releaseAgentRelay(agentTab.current);
			void window.omp.preview.command({ action: "dispose" });
		},
		[],
	);
	const agentHere = state.agent !== null && state.agent.tabId === tabId;
	const pageReady = Boolean(state.url) && !state.crashed && !remoteBlocked;
	const zoomTo = (zoom: number) => command({ action: "zoom", zoom: clampPreviewZoom(zoom) });
	const percent = `${Math.round(state.zoom * 100)}%`;
	const savePdf = async () => {
		try {
			const saved = await window.omp.preview.savePdf();
			if (saved) toast({ variant: "success", title: t("panel.preview.savedPdf"), message: saved });
		} catch (error) {
			toastError({ title: t("panel.preview.savePdfFailed"), error });
		}
	};
	const pageItems: ContextMenuItem[] = [
		{
			id: "new-tab",
			label: t("panel.preview.newTab"),
			icon: Plus,
			disabled: state.tabs.length >= PREVIEW_TAB_LIMIT,
			onSelect: () => command({ action: "newTab" }),
		},
		{
			id: "all-visuals",
			label: t("panel.preview.visual.all"),
			icon: GalleryVerticalEnd,
			disabled: remote || !tabId,
			onSelect: () => setAllVisualsOpen(true),
		},
		{
			id: "comment-element",
			label: t("panel.preview.feedback.element"),
			icon: MousePointerClick,
			disabled: !pageReady,
			separatorBefore: true,
			onSelect: () => feedback.pick("element"),
		},
		{
			id: "comment-region",
			label: t("panel.preview.feedback.region"),
			icon: SquareDashed,
			disabled: !pageReady,
			onSelect: () => feedback.pick("region"),
		},
		{
			id: "css-variables",
			label: t("panel.preview.feedback.variables"),
			icon: SlidersHorizontal,
			disabled: !pageReady,
			onSelect: feedback.openVariables,
		},
		{
			id: "zoom-in",
			label: t("panel.preview.zoomIn"),
			icon: ZoomIn,
			disabled: !pageReady || state.zoom >= PREVIEW_ZOOM_MAX,
			separatorBefore: true,
			onSelect: () => zoomTo(state.zoom + 0.1),
		},
		{
			id: "zoom-out",
			label: t("panel.preview.zoomOut"),
			icon: ZoomOut,
			disabled: !pageReady || state.zoom <= PREVIEW_ZOOM_MIN,
			onSelect: () => zoomTo(state.zoom - 0.1),
		},
		{
			id: "zoom-reset",
			label: t("panel.preview.zoomReset", { percent }),
			disabled: state.zoom === 1,
			onSelect: () => zoomTo(1),
		},
		...(Object.keys(PREVIEW_VIEWPORTS) as PreviewViewport[]).map(
			(viewport, index): ContextMenuItem => ({
				id: `viewport-${viewport}`,
				label: t(`panel.preview.viewport.${viewport}`),
				icon: VIEWPORT_ICONS[viewport],
				checked: state.viewport === viewport,
				separatorBefore: index === 0,
				onSelect: () => command({ action: "viewport", viewport }),
			}),
		),
		{
			id: "save-pdf",
			label: t("panel.preview.savePdf"),
			icon: FileDown,
			disabled: !pageReady || state.loading,
			separatorBefore: true,
			onSelect: () => void savePdf(),
		},
	];
	const problemsText = () =>
		state.problems
			.map(
				problem =>
					`[${problem.level}] ${problem.message}${problem.source ? ` (${problem.source}:${problem.line})` : ""}`,
			)
			.join("\n");
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col" data-preview-panel>
			<form
				className="flex min-h-(--sc-space-10) min-w-0 shrink-0 items-center gap-1 border-b border-(--sc-divider) px-3 py-2"
				onSubmit={event => {
					event.preventDefault();
					const url = previewAddress(input);
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
					placeholder={t("panel.preview.placeholder")}
					onChange={event => {
						setInput(event.target.value);
						setInvalid(false);
					}}
				/>
				<div className="flex shrink-0 items-center">
					{state.zoom !== 1 && (
						<Button
							aria-label={t("panel.preview.zoomReset", { percent })}
							size="sm"
							variant="ghost"
							className="tabular-nums"
							data-preview-zoom
							onClick={() => zoomTo(1)}
						>
							{percent}
						</Button>
					)}
					{state.problems.length > 0 && (
						<Button
							ref={problemsAnchor}
							aria-label={t("panel.preview.problems", { count: previewProblemCount(state.problems.length) })}
							aria-expanded={problemsOpen}
							aria-haspopup="dialog"
							icon={<AlertTriangle />}
							size="sm"
							variant="ghost"
							className="tabular-nums"
							data-preview-problems
							onClick={() => setProblemsOpen(open => !open)}
						>
							{previewProblemCount(state.problems.length)}
						</Button>
					)}
					<IconButton
						label={t(agentHere ? "panel.preview.agent.takeOver" : "panel.preview.agent.allow")}
						title={remote ? t("panel.preview.agent.localOnly") : undefined}
						icon={<Bot />}
						size="sm"
						pressed={agentHere}
						disabled={remote || !runtime || agentStarting}
						onClick={() => (agentHere ? takeOver() : void letAgentIn())}
					/>
					<MenuButton
						align="end"
						icon={<MoreHorizontal />}
						items={pageItems}
						label={t("panel.preview.more")}
						size="sm"
					/>
					<IconButton
						label={t("panel.preview.external")}
						icon={<ExternalLink />}
						size="sm"
						disabled={!address || remoteBlocked}
						onClick={() => {
							if (address) void window.omp.system.openExternal(address);
						}}
					/>
				</div>
			</form>
			<Popover
				anchorRef={problemsAnchor}
				ariaLabel={t("panel.preview.problemsTitle")}
				className="w-96 max-w-[calc(100vw-2rem)] p-3"
				onClose={() => setProblemsOpen(false)}
				open={problemsOpen && state.problems.length > 0}
				placement="bottom-end"
			>
				<div className="flex items-start gap-2 pb-2">
					<div className="min-w-0 flex-1">
						<div className="text-sc-md font-semibold text-(--sc-text)">{t("panel.preview.problemsTitle")}</div>
						<p className="text-sc-xs text-(--sc-text-muted)">
							{t("panel.preview.problemsHint")}
							{state.problems.length >= PREVIEW_PROBLEM_LIMIT &&
								` ${t("panel.preview.problemsCapped", { count: PREVIEW_PROBLEM_LIMIT })}`}
						</p>
					</div>
					<CopyButton label={t("panel.preview.problemsCopy")} size="sm" text={problemsText} />
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							command({ action: "clearProblems" });
							setProblemsOpen(false);
						}}
					>
						{t("common.clear")}
					</Button>
				</div>
				<ol className="max-h-[50vh] overflow-y-auto border-t border-(--sc-divider)" data-preview-problem-list>
					{state.problems.map((problem, index) => (
						<li
							// Rows only append, or all drop at once, so a position names one problem while it shows.
							key={`${index}:${problem.message.slice(0, 40)}`}
							className="flex gap-2 border-b border-(--sc-divider) py-1.5 text-sc-xs"
						>
							{problem.level === "error" ? (
								<XCircle aria-hidden className="mt-px size-(--sc-icon-sm) shrink-0 text-(--sc-danger)" />
							) : (
								<AlertTriangle aria-hidden className="mt-px size-(--sc-icon-sm) shrink-0 text-(--sc-warning)" />
							)}
							<span className="sr-only">
								{t(problem.level === "error" ? "panel.preview.problemError" : "panel.preview.problemWarning")}
							</span>
							<div className="min-w-0 flex-1">
								<div className="whitespace-pre-wrap break-words font-mono text-(--sc-text)">
									{problem.message}
								</div>
								{problem.source && (
									<div className="truncate text-(--sc-text-muted)" title={problem.source}>
										{problem.source}:{problem.line}
									</div>
								)}
							</div>
						</li>
					))}
				</ol>
			</Popover>
			{state.tabs.length > 1 && (
				<nav
					aria-label={t("panel.preview.tabs")}
					className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--sc-divider) px-2 py-1"
					data-preview-tabs
				>
					{state.tabs.map(tab => {
						const active = tab.id === state.activeTab;
						const title = tab.title || tab.url || t("panel.preview.newTab");
						return (
							<div
								key={tab.id}
								className={`flex max-w-48 min-w-24 shrink-0 items-center rounded-(--sc-radius-sm) border ${active ? "border-(--sc-border) bg-(--sc-selected)" : "border-transparent hover:bg-(--sc-hover)"}`}
								data-preview-tab={tab.id}
							>
								<button
									type="button"
									aria-current={active ? "page" : undefined}
									className={`flex h-(--sc-control-sm) min-w-0 flex-1 items-center gap-1.5 truncate rounded-(--sc-radius-sm) px-2 text-left text-sc-xs focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) ${active ? "text-(--sc-text)" : "text-(--sc-text-muted) hover:text-(--sc-text)"}`}
									title={tab.url || title}
									onClick={() => command({ action: "selectTab", id: tab.id })}
								>
									{tab.loading ? (
										<Spinner size="sm" />
									) : (
										<Globe aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									)}
									<span className="truncate">{title}</span>
								</button>
								<IconButton
									label={t("panel.preview.closeTab", { title })}
									icon={<X />}
									size="sm"
									onClick={() => command({ action: "closeTab", id: tab.id })}
								/>
							</div>
						);
					})}
					<IconButton
						label={t("panel.preview.newTab")}
						icon={<Plus />}
						size="sm"
						disabled={state.tabs.length >= PREVIEW_TAB_LIMIT}
						onClick={() => command({ action: "newTab" })}
					/>
				</nav>
			)}
			{state.agent && (
				<div
					className="flex min-w-0 shrink-0 items-center gap-2 border-b border-(--sc-divider) bg-(--sc-accent-soft) px-3 py-1.5 text-sc-xs text-(--sc-text)"
					data-preview-agent={state.agent.attached ? "attached" : "waiting"}
					role="status"
				>
					<span
						aria-hidden
						className={`size-2 shrink-0 rounded-full bg-(--sc-accent) ${state.agent.attached ? "motion-safe:animate-pulse" : "opacity-50"}`}
					/>
					<span className="min-w-0 flex-1 break-words">
						{t(state.agent.attached ? "panel.preview.agent.driving" : "panel.preview.agent.waiting")}
						{state.agent.lastAction && (
							<span className="block truncate font-mono text-(--sc-text-muted)" data-preview-agent-action>
								{state.agent.lastAction}
							</span>
						)}
					</span>
					<Button size="sm" variant="secondary" onClick={takeOver}>
						{t("panel.preview.agent.takeOver")}
					</Button>
				</div>
			)}
			<PreviewFeedbackBar state={state} feedback={feedback} command={command} tabId={tabId} pageReady={pageReady} />
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
			{state.notice && (
				<div className="shrink-0 px-3 pb-2">
					{state.notice.kind === "download" ? (
						<Banner
							live
							onDismiss={() => command({ action: "dismissNotice" })}
							actions={
								<Button
									size="sm"
									variant="secondary"
									icon={<ExternalLink />}
									onClick={() => {
										if (state.notice?.kind === "download")
											void window.omp.system.openExternal(state.notice.url);
										command({ action: "dismissNotice" });
									}}
								>
									{t("panel.preview.external")}
								</Button>
							}
						>
							{t("panel.preview.download", { name: state.notice.filename })}
						</Banner>
					) : (
						<Banner
							live
							variant="warning"
							onDismiss={() => command({ action: "dismissNotice" })}
							actions={
								<Button size="sm" variant="secondary" onClick={() => command({ action: "reload" })}>
									{t("panel.preview.reload")}
								</Button>
							}
						>
							{t("panel.preview.unresponsive")}
						</Banner>
					)}
				</div>
			)}
			<div ref={surface} className="relative min-h-0 flex-1" data-preview-surface>
				{remoteBlocked ? (
					<EmptyState icon={<Globe />} size="sm" title={t("panel.preview.remote")} />
				) : state.crashed ? (
					<div role="alert" className="p-4">
						<EmptyState
							icon={<Globe />}
							size="sm"
							title={t("panel.preview.crashed")}
							actions={
								<Button size="sm" variant="secondary" onClick={() => command({ action: "reload" })}>
									{t("panel.preview.restore")}
								</Button>
							}
						/>
					</div>
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
			{tabId && (
				<AllVisualsDialog
					open={allVisualsOpen}
					onClose={() => setAllVisualsOpen(false)}
					onOpen={visualId => command({ action: "openVisual", tabId, visualId })}
				/>
			)}
		</div>
	);
}
