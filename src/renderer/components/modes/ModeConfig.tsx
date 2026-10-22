/**
 * Inline config for the Goal session mode, embedded in the
 * composer's mode Popover. The config is
 * self-contained: it loads its mode on mount through the mode RPCs
 * (get/set_goal), follows live sidecar
 * events (`goal_updated` → silent re-fetch) and renders compactly for a ~360px
 * popover. The caller renders the
 * heading; changes apply to the current session immediately.
 *
 * Mutations keep the confirmed value while pending. A successful response
 * supplies the effective value; failures remain visible (inline + toast) and
 * preserve the last confirmed state.
 */

import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AgentSessionEvent, RpcGoalState, RpcResponse } from "../../../shared/rpc-types";
import { formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	InlineNotice,
	Input,
	type InputProps,
	ProgressBar,
	SettingInfo,
	SkeletonRows,
	TextArea,
} from "../common";
import { SettingsRow } from "../settings/SettingsLayout";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface ModeRpc<T> {
	state: T | null;
	error: string | null;
	loading: boolean;
	/** A mutation is in flight (inputs disable while it settles). */
	busy: boolean;
	/** The attached sidecar can accept reads and mutations. */
	ready: boolean;
	/** Loud re-fetch: spinner while loading, inline error on failure. */
	refresh: () => void;
	/** Silent re-fetch: updates state on success, leaves the UI alone on failure. */
	sync: () => void;
	/** Apply an event payload directly. */
	apply: (next: T) => void;
	/** Apply only confirmed state from the originating session. */
	mutate: (action: (client: TabRpc) => Promise<RpcResponse>) => Promise<void>;
}

const fetchGoal = (client: TabRpc): Promise<RpcResponse> => client.getGoal();
const pickGoal = (data: unknown): RpcGoalState =>
	(data as RpcGoalState | undefined) ?? { enabled: false, status: "none" };

/** Loads one mode on mount (and again when the session or runtime changes). */
function useModeRpc<T>(
	fetcher: (client: TabRpc) => Promise<RpcResponse>,
	pick: (data: unknown) => T,
	onConfirmed?: (state: T) => void,
): ModeRpc<T> {
	const t = useT();
	const client = useTabRpc();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const generation = useRef(0);
	const sessionId = useSessionStore(s => s.sessionId);
	const [state, setState] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);

	/** One confirmed state value for loading, events and mutations. */
	const setBoth = useCallback(
		(next: T | null) => {
			setState(next);
			if (next !== null) onConfirmed?.(next);
		},
		[onConfirmed],
	);

	const load = useCallback(
		async (silent: boolean) => {
			const version = ++generation.current;
			if (!sidecarReady) {
				setError(t("modesPanel.notConnected"));
				setLoading(false);
				return;
			}
			if (!silent) {
				setLoading(true);
				setError(null);
			}
			try {
				const res = await fetcher(client);
				if (version !== generation.current) return;
				if (res.success) {
					setBoth(pick(res.data));
					if (!silent) setError(null);
				} else {
					setError(res.error);
				}
			} catch (cause) {
				if (version === generation.current) setError(String(cause));
			} finally {
				if (version === generation.current) setLoading(false);
			}
		},
		[sidecarReady, client, fetcher, pick, t, setBoth],
	);

	// A runtime or session replacement drops the old value and reads afresh.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not an input.
	useEffect(() => {
		setState(null);
		setBusy(false);
		void load(false);
		return () => {
			generation.current++;
		};
	}, [load, sessionId]);

	const refresh = useCallback(() => void load(false), [load]);
	const sync = useCallback(() => void load(true), [load]);
	const apply = useCallback(
		(next: T) => {
			generation.current++;
			setBusy(false);
			setLoading(false);
			setBoth(next);
		},
		[setBoth],
	);

	const mutate = useCallback(
		async (action: (client: TabRpc) => Promise<RpcResponse>) => {
			if (!sidecarReady) {
				setError(t("modesPanel.notConnected"));
				return;
			}
			const version = ++generation.current;
			setBusy(true);
			setError(null);
			try {
				const res = await action(client);
				if (!res.success) throw new Error(res.error);
				const settled = res.data == null ? await fetcher(client) : res;
				if (version !== generation.current) return;
				if (!settled.success) throw new Error(settled.error);
				setBoth(pick(settled.data));
			} catch (cause) {
				if (version !== generation.current) return;
				setError(String(cause));
				toastError({ title: t("modesPanel.actionFailed"), error: cause });
			} finally {
				if (version === generation.current) setBusy(false);
			}
		},
		[client, fetcher, pick, sidecarReady, t, setBoth],
	);

	return { state, error, loading, busy, ready: sidecarReady, refresh, sync, apply, mutate };
}

/** Live mode events for the active tab while a config is mounted. */
function useModeEvents(handle: (event: AgentSessionEvent) => void): void {
	useEffect(
		() =>
			window.omp.events.onBatch((events: AgentSessionEvent[]) => {
				if (!acceptsActiveTabEvents()) return;
				for (const event of events) handle(event);
			}),
		[handle],
	);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const GOAL_STATUS_KEY: Record<string, string> = {
	active: "modesPanel.goal.statusValue.active",
	paused: "modesPanel.goal.statusValue.paused",
	"budget-limited": "modesPanel.goal.statusValue.budgetLimited",
	complete: "modesPanel.goal.statusValue.complete",
	dropped: "modesPanel.goal.statusValue.dropped",
};

/** Goal status → badge color (unknown statuses fall back to muted + raw text). */
export function goalStatusVariant(status: string | undefined): BadgeVariant {
	switch (status) {
		case "active":
			return "success";
		case "paused":
			return "warning";
		case "budget-limited":
			return "error";
		case "complete":
			return "info";
		default:
			return "muted";
	}
}

function goalStatusLabel(t: (key: string) => string, status: string | undefined): string {
	if (!status) return "—";
	const key = GOAL_STATUS_KEY[status];
	return key ? t(key) : status;
}

/** Loading / first-load error states; children render once the mode loaded. */
function ModeFrame<T>({ rpc, children }: { rpc: ModeRpc<T>; children: (state: T) => ReactNode }) {
	const t = useT();
	if (rpc.state !== null) return <div className="flex flex-col gap-3">{children(rpc.state)}</div>;
	if (rpc.loading || !rpc.error) {
		return <SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />;
	}
	return (
		<InlineNotice
			action={
				<Button
					disabled={!rpc.ready}
					icon={<RefreshCw />}
					onClick={rpc.refresh}
					size="sm"
					title={!rpc.ready ? t("modesPanel.notConnected") : undefined}
					variant="secondary"
				>
					{t("common.retry")}
				</Button>
			}
			detail={rpc.error}
			live
			title={t("modesPanel.loadFailed")}
			tone="danger"
		/>
	);
}

/** One labelled number field inline with its label; the hint rides an (i) tooltip, `trailing` sits after the field. */
function GoalNumberRow({
	label,
	hint,
	trailing,
	...input
}: Omit<InputProps, "label" | "hint" | "type"> & { label: string; hint: string; trailing?: ReactNode }) {
	return (
		<SettingsRow
			badge={<SettingInfo text={hint} />}
			compactControl
			control={
				<span className="flex items-center gap-2">
					{trailing}
					<span className="w-28">
						<Input aria-label={label} controlSize="sm" type="number" {...input} />
					</span>
				</span>
			}
			label={label}
		/>
	);
}

/** Inline error of a failed mutation while a confirmed state is shown. */
function MutationError({ error }: { error: string | null }) {
	const t = useT();
	if (!error) return null;
	return <InlineNotice detail={error} live title={t("modesPanel.actionFailed")} tone="danger" />;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

/** A minutes field → a positive whole number of minutes, or `null` for "no limit" (empty or 0). */
function parseMinutes(text: string): number | null {
	const value = Number(text);
	return text.trim() !== "" && Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : null;
}

function GoalEnabledView({ rpc, state }: { rpc: ModeRpc<RpcGoalState>; state: RpcGoalState }) {
	const t = useT();
	const [objectiveDraft, setObjectiveDraft] = useState(state.objective ?? "");
	const loadedMinutes =
		typeof state.timeLimitSeconds === "number" ? String(Math.round(state.timeLimitSeconds / 60)) : "";
	const [minutesDraft, setMinutesDraft] = useState(loadedMinutes);
	useEffect(() => {
		setMinutesDraft(loadedMinutes);
	}, [loadedMinutes]);

	// A fresh objective from the sidecar (event re-fetch) replaces the draft.
	const loadedObjective = state.objective ?? "";
	useEffect(() => {
		setObjectiveDraft(loadedObjective);
	}, [loadedObjective]);

	const trimmedObjective = objectiveDraft.trim();
	const objectiveDirty = trimmedObjective !== "" && trimmedObjective !== loadedObjective;
	const tokensUsed = state.tokensUsed ?? 0;
	const timeUsedSeconds = state.timeUsedSeconds ?? 0;
	const tokenBudget = typeof state.tokenBudget === "number" && state.tokenBudget > 0 ? state.tokenBudget : null;
	const timeLimitSeconds =
		typeof state.timeLimitSeconds === "number" && state.timeLimitSeconds > 0 ? state.timeLimitSeconds : null;
	const minutesDirty = (parseMinutes(minutesDraft)?.toString() ?? "") !== loadedMinutes;
	const disabled = rpc.busy || !rpc.ready;
	const notConnected = !rpc.ready ? t("modesPanel.notConnected") : undefined;
	const runAction = (action: "pause" | "resume" | "drop") => {
		void rpc.mutate(client => client.setGoal({ action }));
	};

	return (
		<>
			<SettingsRow
				badge={<SettingInfo text={t("modesPanel.goal.desc")} />}
				compactControl
				control={
					<span className="flex items-center gap-1.5">
						<Badge dot pulse={state.status === "active"} variant={goalStatusVariant(state.status)}>
							{goalStatusLabel(t, state.status)}
						</Badge>
						{state.mode && <Badge variant="muted">{state.mode}</Badge>}
					</span>
				}
				label={t("modesPanel.goal.statusLabel")}
			/>
			<SettingsRow label={t("modesPanel.goal.objectiveLabel")}>
				<TextArea
					aria-label={t("modesPanel.goal.objectiveLabel")}
					autoGrow
					onChange={event => setObjectiveDraft(event.target.value)}
					placeholder={t("modesPanel.goal.objectivePlaceholder")}
					rows={2}
					value={objectiveDraft}
				/>
				{objectiveDirty && (
					<div className="mt-1.5 flex justify-end">
						<Button
							disabled={disabled}
							onClick={() => void rpc.mutate(client => client.setGoal({ objective: trimmedObjective }))}
							size="sm"
							title={notConnected}
							variant="secondary"
						>
							{t("modesPanel.goal.saveObjective")}
						</Button>
					</div>
				)}
			</SettingsRow>
			<div className="flex flex-col gap-1 py-1.5" data-setting-row="true">
				{tokenBudget !== null ? (
					<ProgressBar
						label={t("modesPanel.goal.budget")}
						value={tokensUsed / tokenBudget}
						valueText={`${formatTokens(tokensUsed)} / ${formatTokens(tokenBudget)}`}
					/>
				) : (
					<span className="text-sc-xs text-(--sc-text-muted)">
						{t("modesPanel.goal.noBudget")} · {t("modesPanel.goal.tokensUsed")}:{" "}
						<span className="tabular-nums text-(--sc-text)">{formatTokens(tokensUsed)}</span>
					</span>
				)}
				{timeLimitSeconds !== null ? (
					<ProgressBar
						label={t("modesPanel.goal.timeLimit")}
						value={Math.min(1, timeUsedSeconds / timeLimitSeconds)}
						valueText={`${formatDuration(timeUsedSeconds * 1000)} / ${formatDuration(timeLimitSeconds * 1000)}`}
					/>
				) : (
					<span className="text-sc-xs text-(--sc-text-muted)">
						{t("modesPanel.goal.noTimeLimit")} · {t("modesPanel.goal.timeUsed")}:{" "}
						<span className="tabular-nums text-(--sc-text)">{formatDuration(timeUsedSeconds * 1000)}</span>
					</span>
				)}
			</div>
			<GoalNumberRow
				hint={t("modesPanel.goal.timeLimitHint")}
				label={t("modesPanel.goal.timeLimitLabel")}
				min={0}
				onChange={event => setMinutesDraft(event.target.value)}
				placeholder={t("modesPanel.goal.timeLimitPlaceholder")}
				step={5}
				trailing={
					minutesDirty && (
						<Button
							disabled={disabled || state.status === "complete"}
							onClick={() =>
								void rpc.mutate(client => client.setGoal({ timeLimitMinutes: parseMinutes(minutesDraft) }))
							}
							size="sm"
							title={notConnected}
							variant="secondary"
						>
							{t("modesPanel.goal.saveTimeLimit")}
						</Button>
					)
				}
				value={minutesDraft}
			/>
			<div className="flex items-center justify-end gap-2 pt-1.5">
				{state.status === "paused" ? (
					<Button
						disabled={disabled}
						onClick={() => runAction("resume")}
						size="sm"
						title={notConnected}
						variant="primary"
					>
						{t("modesPanel.goal.resume")}
					</Button>
				) : (
					<Button
						disabled={disabled || state.status !== "active"}
						onClick={() => runAction("pause")}
						size="sm"
						title={notConnected}
						variant="secondary"
					>
						{t("modesPanel.goal.pause")}
					</Button>
				)}
				<Button
					disabled={disabled}
					onClick={() => runAction("drop")}
					size="sm"
					title={notConnected}
					variant="ghost"
				>
					{t("modesPanel.goal.drop")}
				</Button>
			</div>
		</>
	);
}

function GoalStartForm({ rpc }: { rpc: ModeRpc<RpcGoalState> }) {
	const t = useT();
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const [minutes, setMinutes] = useState("");
	const trimmed = objective.trim();
	const parsedBudget = Number(budget);
	const tokenBudget =
		budget.trim() !== "" && Number.isFinite(parsedBudget) && parsedBudget > 0 ? Math.floor(parsedBudget) : null;
	const timeLimitMinutes = parseMinutes(minutes);

	return (
		<>
			<SettingsRow
				badge={<SettingInfo text={t("modesPanel.goal.desc")} />}
				label={t("modesPanel.goal.objectiveLabel")}
			>
				<TextArea
					aria-label={t("modesPanel.goal.objectiveLabel")}
					autoGrow
					onChange={event => setObjective(event.target.value)}
					placeholder={t("modesPanel.goal.objectivePlaceholder")}
					rows={2}
					value={objective}
				/>
			</SettingsRow>
			<GoalNumberRow
				hint={t("modesPanel.goal.budgetHint")}
				label={t("modesPanel.goal.budgetLabel")}
				min={0}
				onChange={event => setBudget(event.target.value)}
				placeholder={t("modesPanel.goal.budgetPlaceholder")}
				step={1000}
				value={budget}
			/>
			<GoalNumberRow
				hint={t("modesPanel.goal.timeLimitHint")}
				label={t("modesPanel.goal.timeLimitLabel")}
				min={0}
				onChange={event => setMinutes(event.target.value)}
				placeholder={t("modesPanel.goal.timeLimitPlaceholder")}
				step={5}
				value={minutes}
			/>
			<div className="flex justify-end pt-1.5">
				<Button
					disabled={!trimmed || rpc.busy || !rpc.ready}
					loading={rpc.busy}
					onClick={() =>
						void rpc.mutate(client =>
							client.setGoal({
								objective: trimmed,
								...(tokenBudget === null ? {} : { tokenBudget }),
								...(timeLimitMinutes === null ? {} : { timeLimitMinutes }),
							}),
						)
					}
					size="sm"
					title={!rpc.ready ? t("modesPanel.notConnected") : undefined}
					variant="primary"
				>
					{t("modesPanel.goal.start")}
				</Button>
			</div>
		</>
	);
}

export function GoalModeConfig() {
	const rpc = useModeRpc(fetchGoal, pickGoal);
	const syncGoal = rpc.sync;
	useModeEvents(
		useCallback(
			(event: AgentSessionEvent) => {
				if (event.type === "goal_updated") syncGoal();
			},
			[syncGoal],
		),
	);
	return (
		<ModeFrame rpc={rpc}>
			{state => (
				<>
					<div className="settings-section-body">
						{state.enabled ? <GoalEnabledView rpc={rpc} state={state} /> : <GoalStartForm rpc={rpc} />}
					</div>
					<MutationError error={rpc.error} />
				</>
			)}
		</ModeFrame>
	);
}
