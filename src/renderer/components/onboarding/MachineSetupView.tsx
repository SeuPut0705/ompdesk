/**
 * This machine's automatic setup, shown (never driven): main installs what is
 * missing on its own, so there is no install button anywhere. The install view
 * lists the required items in order, the running (or last failed) item's exact
 * command, location and output, Cancel while it runs, and Retry with the manual
 * steps after a failure or a cancel. The first-run step and the sidecar
 * banner's "Show setup" dialog reuse it; Settings › General lists every item
 * through the same parts.
 */

import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleSlash,
	Clock,
	ExternalLink,
	Info,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { SetupFailure, SetupItemId, SetupItemPhase, SetupItemState, SetupState } from "../../../shared/setup";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, formatBytes, formatElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { Banner, Button, CopyButton, ProgressBar, Spinner } from "../common";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Product names: never translated. */
export const SETUP_ITEM_NAMES: Record<SetupItemId, string> = {
	bun: "Bun",
	git: "Git",
	omp: "omp",
	gh: "GitHub CLI",
	node: "Node.js",
};

/** Phases that ended without the item: the user can ask for another attempt. */
export const SETUP_RETRYABLE: readonly SetupItemPhase[] = ["failed", "cancelled", "backoff"];
/** Phases that show the item's command, location and output. */
export const SETUP_DETAILED: readonly SetupItemPhase[] = ["running", "failed", "cancelled", "backoff"];

/** Read this machine's setup state once, then follow main's pushes. */
export function useMachineSetupState(): SetupState | null {
	const state = useMachineSetupStore(store => store.state);
	useEffect(() => {
		useMachineSetupStore.getState().ensureLoaded();
	}, []);
	return state;
}

/**
 * True while this tab is local, its omp is not usable (the session is in
 * `error`/`exited`) and machine setup says omp is missing, being installed, or
 * was until main's restart brings the session back. Remote tabs never show
 * this machine's setup: their host sets itself up.
 */
export function useMachineSetupNeeded(): boolean {
	const tabId = useRuntimeTabId();
	const local = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.device === undefined);
	const status = useSessionStore(state => state.status);
	const state = useMachineSetupStore(store => store.state);
	const installSeen = useMachineSetupStore(store => store.installSeen);
	const down = local && (status === "error" || status === "exited");
	useEffect(() => {
		if (down) useMachineSetupStore.getState().ensureLoaded();
	}, [down]);
	useEffect(() => {
		if (status === "ready" && installSeen) useMachineSetupStore.getState().clearInstallSeen();
	}, [installSeen, status]);
	return down && state !== null && (!state.ompReady || state.requiredRunning || installSeen);
}

export function setupPhaseText(t: Translate, item: SetupItemState): string {
	if (item.phase === "present") {
		const version = item.presence?.kind === "present" ? item.presence.version : null;
		return version ? t("machineSetup.phase.presentVersion", { version }) : t("machineSetup.phase.present");
	}
	if (item.phase === "running" && item.method === "omp-update") return t("machineSetup.phase.updating");
	if (item.phase === "running" && item.progress?.download) return t("machineSetup.phase.downloading");
	return t(`machineSetup.phase.${item.phase}`);
}

/**
 * A running item's progress: its place in the install run, how long it has
 * run, and, while main downloads its file, the bytes against the announced
 * size. The bar is determinate only then; an installer's own work has no
 * honest percent, so it slides.
 */
export function SetupProgressLine({ item, className }: { item: SetupItemState; className?: string }) {
	const t = useT();
	const progress = item.phase === "running" ? item.progress : null;
	const now = useNowTick(progress !== null);
	if (!progress) return null;
	const { download } = progress;
	const total = download?.total ?? null;
	const bytes =
		download === null
			? ""
			: total === null
				? t("machineSetup.progress.downloaded", { received: formatBytes(download.received) })
				: t("machineSetup.progress.download", {
						received: formatBytes(download.received),
						total: formatBytes(total),
					});
	const parts = [
		// "Step 1 of 1" says nothing: the place in the run shows only when the run has several steps.
		progress.steps > 1 ? t("machineSetup.progress.step", { step: progress.step, steps: progress.steps }) : "",
		bytes,
		formatElapsed(now - progress.startedAt),
	];
	return (
		<div className={cx("flex min-w-0 flex-col gap-1", className)} data-setup-progress>
			<ProgressBar
				ariaLabel={t("machineSetup.progress.label", { name: SETUP_ITEM_NAMES[item.id] })}
				tone="progress"
				value={download && total !== null ? download.received / total : undefined}
			/>
			<p className="text-sc-xs break-words text-(--sc-text-muted) tabular-nums">
				{parts.filter(Boolean).join(" · ")}
			</p>
		</div>
	);
}

/** What detection found beyond the phase: an old version or a broken install. */
export function setupPresenceNote(t: Translate, item: SetupItemState): string | null {
	const presence = item.presence;
	if (presence?.kind === "outdated") {
		return t("machineSetup.presence.outdated", { version: presence.version, minimum: presence.minimum });
	}
	if (presence?.kind === "broken") return t("machineSetup.presence.broken", { detail: presence.detail });
	return null;
}

/** Where detection found the item, when it found one. */
export function setupPresencePath(item: SetupItemState): string | null {
	const presence = item.presence;
	return presence && presence.kind !== "missing" ? presence.path : null;
}

/** Why the last install ended without the item, as one sentence. */
export function setupFailureText(t: Translate, item: SetupItemState, failure: SetupFailure): string {
	switch (failure.reason) {
		case "exit":
			return failure.exitCode === null || failure.exitCode === undefined
				? t("machineSetup.reason.exitUnknown")
				: t("machineSetup.reason.exit", { code: failure.exitCode });
		case "not-detected":
			return t("machineSetup.reason.notDetected", { name: SETUP_ITEM_NAMES[item.id] });
		case "prerequisite":
			return t("machineSetup.reason.prerequisite", { name: SETUP_ITEM_NAMES[item.id] });
		default:
			return t(`machineSetup.reason.${failure.reason}`);
	}
}

/** The state mark: the only colored part of a row. */
export function SetupMark({ phase }: { phase: SetupItemPhase }) {
	const icon = "size-4 shrink-0";
	switch (phase) {
		case "present":
			return <CheckCircle2 aria-hidden className={cx(icon, "text-(--sc-success)")} />;
		case "running":
		case "checking":
			return <Spinner size="sm" />;
		case "queued":
			return <Clock aria-hidden className={cx(icon, "text-(--sc-text-muted)")} />;
		case "failed":
			return <XCircle aria-hidden className={cx(icon, "text-(--sc-danger)")} />;
		case "backoff":
			return <AlertTriangle aria-hidden className={cx(icon, "text-(--sc-danger)")} />;
		case "cancelled":
			return <CircleSlash aria-hidden className={cx(icon, "text-(--sc-warning)")} />;
		case "requested":
			return <Info aria-hidden className={cx(icon, "text-(--sc-info)")} />;
		default:
			return <Circle aria-hidden className={cx(icon, "text-(--sc-text-muted)")} />;
	}
}

function CodeLine({ value, label }: { value: string; label?: string }) {
	const t = useT();
	return (
		<div className="flex min-w-0 items-start gap-1">
			<code
				aria-label={label}
				className="min-w-0 flex-1 rounded-(--sc-radius-sm) bg-(--sc-code-bg) px-2 py-1 font-mono text-sc-xs break-all whitespace-pre-wrap text-(--sc-text) select-text"
			>
				{value}
			</code>
			<CopyButton label={t("machineSetup.copy")} text={value} />
		</div>
	);
}

/** The exact command and its target, plus the OS prompt it will raise. */
export function SetupItemDetails({ item }: { item: SetupItemState }) {
	const t = useT();
	if (!item.command && !item.location && !item.prompt) return null;
	return (
		<dl className="flex min-w-0 flex-col gap-2 text-sc-sm">
			{item.command && (
				<div className="min-w-0">
					<dt className="text-sc-xs text-(--sc-text-muted)">{t("machineSetup.command")}</dt>
					<dd className="mt-0.5 min-w-0">
						<CodeLine value={item.command} />
					</dd>
				</div>
			)}
			{item.location && (
				<div className="min-w-0">
					<dt className="text-sc-xs text-(--sc-text-muted)">{t("machineSetup.location")}</dt>
					<dd className="mt-0.5 min-w-0 font-mono text-sc-xs break-all text-(--sc-text-secondary) select-text">
						{item.location}
					</dd>
				</div>
			)}
			{item.prompt && (
				<p className="flex min-w-0 items-start gap-1.5 text-sc-sm text-(--sc-text-secondary)">
					<Info aria-hidden className="mt-0.5 size-4 shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0 break-words">{t(`machineSetup.prompt.${item.prompt}`)}</span>
				</p>
			)}
		</dl>
	);
}

/** Installer output, collapsed by default; follows the tail while open. */
export function SetupOutput({ item }: { item: SetupItemState }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	const ref = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (open && element && item.output) element.scrollTop = element.scrollHeight;
	}, [item.output, open]);
	if (!item.output && item.phase !== "running") return null;
	return (
		<div className="min-w-0">
			<Button
				aria-controls={id}
				aria-expanded={open}
				data-testid="setup-output-toggle"
				icon={open ? <ChevronDown /> : <ChevronRight />}
				onClick={() => setOpen(value => !value)}
				size="sm"
				variant="ghost"
			>
				{open ? t("machineSetup.output.hide") : t("machineSetup.output.show")}
			</Button>
			{open && (
				<pre
					className="mt-1 max-h-64 min-w-0 overflow-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-code-bg) px-2 py-1.5 font-mono text-sc-xs break-all whitespace-pre-wrap text-(--sc-text-secondary) select-text"
					id={id}
					ref={ref}
				>
					{!item.output ? (
						t("machineSetup.output.empty")
					) : hasAnsi(item.output) ? (
						<AnsiText text={item.output} />
					) : (
						item.output
					)}
				</pre>
			)}
		</div>
	);
}

/** What to run by hand, and the official page. */
export function SetupManualSteps({ item }: { item: SetupItemState }) {
	const t = useT();
	if (item.manualCommands.length === 0 && !item.manualUrl) return null;
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<p className="text-sc-sm font-medium text-(--sc-text)">{t("machineSetup.manual.title")}</p>
			{item.manualCommands.map(command => (
				<CodeLine key={command} value={command} />
			))}
			{item.manualUrl && (
				<div>
					<Button
						icon={<ExternalLink />}
						onClick={() => void window.omp.system.openExternal(item.manualUrl)}
						size="sm"
						variant="secondary"
					>
						{t("machineSetup.manual.open")}
					</Button>
				</div>
			)}
		</div>
	);
}

/** Why an item ended without being installed: failed, stopped, backing off, or out of reach. */
export function SetupItemBanner({ item, retry }: { item: SetupItemState; retry?: () => void }) {
	const t = useT();
	const name = SETUP_ITEM_NAMES[item.id];
	const { phase, failure } = item;
	let variant: "danger" | "warning" | "info";
	let lead: ReactNode;
	switch (phase) {
		case "failed":
			variant = "danger";
			lead = failure ? setupFailureText(t, item, failure) : t("machineSetup.reason.unknown");
			break;
		case "backoff":
			variant = "danger";
			lead = failure
				? `${setupFailureText(t, item, failure)} ${t("machineSetup.backoffHint")}`
				: t("machineSetup.backoffHint");
			break;
		case "cancelled":
			variant = "warning";
			lead = t("machineSetup.cancelledHint");
			break;
		case "unavailable":
			variant = "warning";
			lead = t("machineSetup.unavailableHint", { name });
			break;
		case "idle":
			variant = "info";
			lead = t("machineSetup.idleHint", { name });
			break;
		default:
			return null;
	}
	const canRetry = retry !== undefined && SETUP_RETRYABLE.includes(phase);
	return (
		<Banner
			actions={
				canRetry ? (
					<Button data-testid="setup-retry" icon={<RefreshCw />} onClick={retry} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				) : undefined
			}
			live
			title={t(`machineSetup.banner.${phase}`, { name })}
			variant={variant}
		>
			<div className="flex min-w-0 flex-col gap-2">
				<p className="text-sc-sm break-words">{lead}</p>
				{phase !== "cancelled" && failure?.detail && (
					<p className="font-mono text-sc-xs break-all text-(--sc-text-muted) select-text">{failure.detail}</p>
				)}
				<SetupManualSteps item={item} />
			</div>
		</Banner>
	);
}

/** The required item the view explains: the running one, else the first that ended without it. */
function focusItem(required: SetupItemState[]): SetupItemState | null {
	return (
		required.find(item => item.phase === "running") ??
		required.find(item => SETUP_DETAILED.includes(item.phase)) ??
		required.find(item => item.phase === "unavailable" || item.phase === "idle") ??
		null
	);
}

/**
 * What the full-window screen's heading says. The screen is up while setup runs
 * ("installing", or "updating" when omp is below the minimum and `omp update`
 * runs) and also while it has stopped without omp (failed, stopped by the user,
 * paused, unavailable): then the heading names the item that is missing and the
 * text asks for a retry instead of promising that nothing is left to do.
 */
export type SetupScreen =
	| { kind: "installing" | "updating" }
	| { kind: "stopped"; item: SetupItemId; outdated: boolean };

export function setupScreen(state: SetupState | null): SetupScreen {
	if (!state) return { kind: "installing" };
	const focus = focusItem(state.items.filter(item => item.required));
	if (focus?.phase === "running") return { kind: focus.method === "omp-update" ? "updating" : "installing" };
	if (!focus || state.requiredRunning) return { kind: "installing" };
	return { kind: "stopped", item: focus.id, outdated: focus.presence?.kind === "outdated" };
}

/** The install view: required items for this platform, in install order. */
export function MachineSetupView() {
	const t = useT();
	const state = useMachineSetupState();
	const loadError = useMachineSetupStore(store => store.loadError);
	const retry = useMachineSetupStore(store => store.retry);
	const cancel = useMachineSetupStore(store => store.cancel);
	const [cancelling, setCancelling] = useState(false);

	if (!state) {
		return (
			<div className="flex min-w-0 flex-col gap-3" data-testid="machine-setup">
				{loadError ? (
					<Banner
						actions={
							<Button onClick={() => void useMachineSetupStore.getState().load()} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						}
						live
						title={t("machineSetup.loadFailed")}
						variant="danger"
					/>
				) : (
					<Spinner label={t("machineSetup.checking")} />
				)}
			</div>
		);
	}

	const required = state.items.filter(item => item.required);
	const focus = focusItem(required);
	const allPresent = required.every(item => item.phase === "present");

	return (
		<div className="flex min-w-0 flex-col gap-4" data-testid="machine-setup">
			<ol aria-label={t("machineSetup.requiredList")} className="flex min-w-0 flex-col gap-2">
				{required.map(item => {
					const note = setupPresenceNote(t, item);
					return (
						<li
							className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sc-md"
							data-phase={item.phase}
							data-setup-item={item.id}
							key={item.id}
						>
							<span className="flex min-w-0 items-center gap-2">
								<SetupMark phase={item.phase} />
								<span className="font-medium text-(--sc-text)">{SETUP_ITEM_NAMES[item.id]}</span>
							</span>
							<span className="min-w-0 text-sc-sm break-words text-(--sc-text-secondary)">
								{setupPhaseText(t, item)}
								{note && <span className="text-(--sc-text-muted)"> · {note}</span>}
							</span>
							<SetupProgressLine className="basis-full" item={item} />
						</li>
					);
				})}
			</ol>

			{focus && SETUP_DETAILED.includes(focus.phase) && (
				<div className="flex min-w-0 flex-col gap-3 border-t border-(--sc-divider) pt-3">
					<SetupItemDetails item={focus} />
					<SetupOutput item={focus} />
				</div>
			)}

			{focus && (
				<SetupItemBanner
					item={focus}
					retry={() => {
						void retry(focus.id);
					}}
				/>
			)}

			{state.requiredRunning && (
				<div className="flex flex-wrap items-center gap-3">
					<p className="min-w-0 flex-1 text-sc-sm break-words text-(--sc-text-muted)">
						{t("machineSetup.runningHint")}
					</p>
					<Button
						data-testid="setup-cancel"
						loading={cancelling}
						onClick={() => {
							setCancelling(true);
							void cancel().finally(() => setCancelling(false));
						}}
						size="sm"
						variant="secondary"
					>
						{t("common.cancel")}
					</Button>
				</div>
			)}

			{allPresent && state.ompReady && (
				<div aria-live="polite" role="status">
					<Spinner label={t("machineSetup.starting")} />
				</div>
			)}
		</div>
	);
}
