/**
 * Inline config for the Vibe / Goal / Loop session modes, embedded in the
 * composer's mode Popover (design-spec §2.2: no Modes modal). Each config is
 * self-contained: it loads its mode on mount through the mode RPCs
 * (get/set_vibe_mode, get/set_goal, get/set_loop_mode), follows live sidecar
 * events (`goal_updated` → silent re-fetch, `loop_mode_update` → applied in
 * place) and renders compactly for a ~360px popover. The caller renders the
 * heading; changes apply to the current session immediately.
 *
 * Mutations keep the confirmed value while pending. A successful response
 * supplies the effective value; failures remain visible (inline + toast) and
 * preserve the last confirmed state.
 */

import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
	AgentSessionEvent,
	RpcGoalState,
	RpcLoopModeState,
	RpcResponse,
	RpcVibeModeState,
} from "../../../shared/rpc-types";
import { formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { loopLimitText, normalizeLoopUpdate, parseLoopLimit } from "../../lib/loop-mode";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	InlineNotice,
	Input,
	ProgressBar,
	Spinner,
	SwitchField,
	TextArea,
} from "../common";

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

const fetchVibeMode = (client: TabRpc): Promise<RpcResponse> => client.getVibeMode();
const pickVibeMode = (data: unknown): RpcVibeModeState => (data as RpcVibeModeState | undefined) ?? { enabled: false };
const fetchGoal = (client: TabRpc): Promise<RpcResponse> => client.getGoal();
const pickGoal = (data: unknown): RpcGoalState =>
	(data as RpcGoalState | undefined) ?? { enabled: false, status: "none" };
const fetchLoopMode = (client: TabRpc): Promise<RpcResponse> => client.getLoopMode();
const pickLoopMode = (data: unknown): RpcLoopModeState =>
	(data as RpcLoopModeState | undefined) ?? { enabled: false, state: "off" };

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

/** Loop run-state → badge color (running pulses, off dims). */
export const LOOP_STATE_VARIANT: Record<RpcLoopModeState["state"], BadgeVariant> = {
	off: "muted",
	waiting: "info",
	running: "success",
	paused: "warning",
};

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
		return (
			<div className="flex justify-center py-4">
				<Spinner label={t("common.loading")} />
			</div>
		);
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

function Description({ children }: { children: ReactNode }) {
	return <p className="text-sc-sm text-(--sc-text-muted)">{children}</p>;
}

function FieldLabel({ children }: { children: ReactNode }) {
	return <span className="text-sc-xs font-medium text-(--sc-text-muted)">{children}</span>;
}

/** Inline error of a failed mutation while a confirmed state is shown. */
function MutationError({ error }: { error: string | null }) {
	const t = useT();
	if (!error) return null;
	return <InlineNotice detail={error} live title={t("modesPanel.actionFailed")} tone="danger" />;
}

// ---------------------------------------------------------------------------
// Vibe
// ---------------------------------------------------------------------------

export function VibeModeConfig() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const confirmVibe = useCallback(
		(state: RpcVibeModeState) => {
			const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
			session.setState({ vibeModeEnabled: state.enabled });
		},
		[tabId],
	);
	const rpc = useModeRpc(fetchVibeMode, pickVibeMode, confirmVibe);
	return (
		<ModeFrame rpc={rpc}>
			{state => (
				<>
					<Description>{t("modesPanel.vibe.desc")}</Description>
					<SwitchField
						checked={state.enabled}
						className="-mx-2"
						description={t("modesPanel.vibe.toggleDesc")}
						disabled={rpc.busy || !rpc.ready}
						label={t("modesPanel.vibe.toggleLabel")}
						onCheckedChange={next => void rpc.mutate(client => client.setVibeMode(next))}
						title={!rpc.ready ? t("modesPanel.notConnected") : undefined}
					/>
					{!state.enabled && typeof state.killedWorkers === "number" && state.killedWorkers > 0 && (
						<p className="text-sc-sm text-(--sc-warning)">
							{t("modesPanel.vibe.killedWorkers", { count: state.killedWorkers })}
						</p>
					)}
					<MutationError error={rpc.error} />
				</>
			)}
		</ModeFrame>
	);
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
			<div className="flex flex-wrap items-center gap-2">
				<FieldLabel>{t("modesPanel.goal.statusLabel")}</FieldLabel>
				<Badge dot pulse={state.status === "active"} variant={goalStatusVariant(state.status)}>
					{goalStatusLabel(t, state.status)}
				</Badge>
				{state.mode && <Badge variant="muted">{state.mode}</Badge>}
			</div>
			<TextArea
				autoGrow
				label={t("modesPanel.goal.objectiveLabel")}
				onChange={event => setObjectiveDraft(event.target.value)}
				placeholder={t("modesPanel.goal.objectivePlaceholder")}
				rows={2}
				value={objectiveDraft}
			/>
			{objectiveDirty && (
				<div className="flex justify-end">
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
			<div className="flex flex-col gap-1.5">
				{tokenBudget !== null ? (
					<ProgressBar
						label={t("modesPanel.goal.budget")}
						value={tokensUsed / tokenBudget}
						valueText={`${formatTokens(tokensUsed)} / ${formatTokens(tokenBudget)}`}
					/>
				) : (
					<span className="text-sc-sm text-(--sc-text-subtle)">{t("modesPanel.goal.noBudget")}</span>
				)}
				{timeLimitSeconds !== null ? (
					<ProgressBar
						label={t("modesPanel.goal.timeLimit")}
						value={Math.min(1, timeUsedSeconds / timeLimitSeconds)}
						valueText={`${formatDuration(timeUsedSeconds * 1000)} / ${formatDuration(timeLimitSeconds * 1000)}`}
					/>
				) : (
					<span className="text-sc-sm text-(--sc-text-subtle)">{t("modesPanel.goal.noTimeLimit")}</span>
				)}
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sc-sm text-(--sc-text-muted)">
					<span>
						{t("modesPanel.goal.tokensUsed")}:{" "}
						<span className="tabular-nums text-(--sc-text)">{formatTokens(tokensUsed)}</span>
					</span>
					<span>
						{t("modesPanel.goal.timeUsed")}:{" "}
						<span className="tabular-nums text-(--sc-text)">{formatDuration(timeUsedSeconds * 1000)}</span>
					</span>
				</div>
			</div>
			<div className="flex flex-col gap-2">
				<Input
					hint={t("modesPanel.goal.timeLimitHint")}
					label={t("modesPanel.goal.timeLimitLabel")}
					min={0}
					onChange={event => setMinutesDraft(event.target.value)}
					placeholder={t("modesPanel.goal.timeLimitPlaceholder")}
					step={5}
					type="number"
					value={minutesDraft}
				/>
				{minutesDirty && (
					<div className="flex justify-end">
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
					</div>
				)}
			</div>
			<div className="flex items-center gap-2">
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
			<TextArea
				autoGrow
				label={t("modesPanel.goal.objectiveLabel")}
				onChange={event => setObjective(event.target.value)}
				placeholder={t("modesPanel.goal.objectivePlaceholder")}
				rows={2}
				value={objective}
			/>
			<Input
				hint={t("modesPanel.goal.budgetHint")}
				label={t("modesPanel.goal.budgetLabel")}
				min={0}
				onChange={event => setBudget(event.target.value)}
				placeholder={t("modesPanel.goal.budgetPlaceholder")}
				step={1000}
				type="number"
				value={budget}
			/>
			<Input
				hint={t("modesPanel.goal.timeLimitHint")}
				label={t("modesPanel.goal.timeLimitLabel")}
				min={0}
				onChange={event => setMinutes(event.target.value)}
				placeholder={t("modesPanel.goal.timeLimitPlaceholder")}
				step={5}
				type="number"
				value={minutes}
			/>
			<div className="flex justify-end">
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
	const t = useT();
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
					<Description>{t("modesPanel.goal.desc")}</Description>
					{state.enabled ? <GoalEnabledView rpc={rpc} state={state} /> : <GoalStartForm rpc={rpc} />}
					<MutationError error={rpc.error} />
				</>
			)}
		</ModeFrame>
	);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export function LoopModeConfig() {
	const t = useT();
	const rpc = useModeRpc(fetchLoopMode, pickLoopMode);
	const [argsDraft, setArgsDraft] = useState("");
	const applyLoop = rpc.apply;
	useModeEvents(
		useCallback(
			(event: AgentSessionEvent) => {
				if (event.type !== "loop_mode_update") return;
				const next = normalizeLoopUpdate(event);
				if (next) applyLoop(next);
			},
			[applyLoop],
		),
	);

	return (
		<ModeFrame rpc={rpc}>
			{state => {
				const limit = parseLoopLimit(state.limit);
				const args = argsDraft.trim();
				return (
					<>
						<Description>{t("modesPanel.loop.desc")}</Description>
						{!state.enabled && (
							<Input
								hint={t("modesPanel.loop.argsHint")}
								label={t("modesPanel.loop.argsLabel")}
								onChange={event => setArgsDraft(event.target.value)}
								placeholder={t("modesPanel.loop.argsPlaceholder")}
								value={argsDraft}
							/>
						)}
						<SwitchField
							badge={
								<Badge dot pulse={state.state === "running"} variant={LOOP_STATE_VARIANT[state.state]}>
									{t(`modesPanel.loop.state.${state.state}`)}
								</Badge>
							}
							checked={state.enabled}
							className="-mx-2"
							description={t("modesPanel.loop.toggleDesc")}
							disabled={rpc.busy || !rpc.ready}
							label={t("modesPanel.loop.toggleLabel")}
							onCheckedChange={next =>
								void rpc.mutate(client => client.setLoopMode(next, args === "" ? undefined : args))
							}
							title={!rpc.ready ? t("modesPanel.notConnected") : undefined}
						/>
						{state.enabled && (
							<dl className="flex flex-col gap-2 text-sc-sm">
								<div className="flex flex-col gap-1">
									<dt className="text-sc-xs font-medium text-(--sc-text-muted)">
										{t("modesPanel.loop.promptLabel")}
									</dt>
									<dd className="break-words whitespace-pre-wrap text-(--sc-text)">
										{state.prompt || (
											<span className="text-(--sc-text-subtle)">{t("modesPanel.loop.noPrompt")}</span>
										)}
									</dd>
								</div>
								<div className="flex items-baseline gap-2">
									<dt className="text-sc-xs font-medium text-(--sc-text-muted)">
										{t("modesPanel.loop.limitLabel")}
									</dt>
									<dd className="tabular-nums text-(--sc-text)">
										{limit ? loopLimitText(t, limit) : t("modesPanel.loop.noLimit")}
									</dd>
								</div>
							</dl>
						)}
						<MutationError error={rpc.error} />
					</>
				);
			}}
		</ModeFrame>
	);
}
