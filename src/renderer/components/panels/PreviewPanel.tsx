import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, RotateCw, Square } from "lucide-react";
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
import { sessionRuntime, useRuntimeTabId, useSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { Button, EmptyState, ErrorDetail, IconButton, Spinner } from "../common";

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
	const remoteBlocked = remote && isLoopbackUrl(input);
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
			if (agentTab.current) releaseAgentRelay(agentTab.current);
			void window.omp.preview.command({ action: "dispose" });
		},
		[],
	);
	const agentHere = state.agent !== null && state.agent.tabId === tabId;
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
						label={t(agentHere ? "panel.preview.agent.takeOver" : "panel.preview.agent.allow")}
						title={remote ? t("panel.preview.agent.localOnly") : undefined}
						icon={<Bot />}
						size="sm"
						pressed={agentHere}
						disabled={remote || !runtime || agentStarting}
						onClick={() => (agentHere ? takeOver() : void letAgentIn())}
					/>
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
