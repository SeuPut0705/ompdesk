/**
 * Plan dock card: plan-mode status + review rendered as a live card in the
 * center dock above the composer (previously the workspace drawer's plan
 * tab). Visible only while plan mode is enabled — the composer mode chips
 * carry the on/off affordance otherwise.
 *
 * The plan document is read from disk through the `fs:read-plan` main-process
 * IPC — kept OFF the RPC bus so the streaming poll never injects the plan
 * into the model context or appends bashExecution entries to the transcript.
 * Resolution mirrors the agent: `local://` lands in `<session file minus
 * .jsonl>/local/<name>`, absolute paths pass through, anything else resolves
 * against the session cwd; when the configured path is absent the main
 * process falls back to the newest `*plan.md` in the local root.
 *
 * Structured plan approval (the TUI's `xd://propose` popup with its three
 * execute options) is NOT installed by the RPC host — approve / request
 * changes here send prompt/steer messages instead, and the footer says so.
 */

import { CheckCircle2, Circle, ClipboardList, FileWarning, MessageSquare, RefreshCw, Send } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanModeState } from "../../../../shared/rpc-types";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { type TabRpc, useTabRpc } from "../../../lib/tab-rpc";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Button, EmptyState, ErrorDetail, IconButton, Spinner, Switch, Tabs, TextArea } from "../../common";
import { PanelActions } from "../../panels/PanelChrome";
import { DockCard } from "./DockCard";

const POLL_STREAMING_MS = 3000;

interface ResolvedPlanPath {
	fsPath: string;
	/** Session-local root (`<artifacts>/local`) when the plan lives under `local://`. */
	localRoot: string | null;
}

/**
 * Mirror of the agent-side `readPlanFile` resolution: `local://` URLs land in
 * `<sessionFile minus .jsonl>/local/`, absolute paths pass through, anything
 * else resolves against the session cwd. Returns null when a `local://` path
 * cannot be resolved because the session has no file on disk yet.
 */
function resolvePlanFsPath(planFilePath: string, sessionFile: string | null, cwd: string): ResolvedPlanPath | null {
	if (planFilePath.startsWith("local:")) {
		if (!sessionFile?.endsWith(".jsonl")) return null;
		const name = planFilePath.replace(/^local:\/+/, "");
		if (!name) return null;
		const localRoot = `${sessionFile.slice(0, -".jsonl".length)}/local`;
		return { fsPath: `${localRoot}/${name}`, localRoot };
	}
	if (planFilePath.startsWith("/")) return { fsPath: planFilePath, localRoot: null };
	if (!cwd) return null;
	return { fsPath: `${cwd.replace(/\/+$/, "")}/${planFilePath}`, localRoot: null };
}

interface PlanStep {
	index: number;
	text: string;
	done: boolean;
	/** True when the source line was a `- [ ]` / `- [x]` checklist item. */
	checkbox: boolean;
}

interface PlanSection {
	heading: string | null;
	steps: PlanStep[];
}

/** Extract ordered steps (checkboxes, numbered and bulleted items) grouped under their headings. */
function parsePlanSections(markdown: string): PlanSection[] {
	const sections: PlanSection[] = [];
	let current: PlanSection = { heading: null, steps: [] };
	let ordinal = 0;
	const pushCurrent = () => {
		if (current.steps.length > 0) sections.push(current);
	};
	for (const line of markdown.split("\n")) {
		const heading = /^#{1,6}\s+(.+)$/.exec(line);
		if (heading) {
			pushCurrent();
			current = { heading: heading[1].trim(), steps: [] };
			continue;
		}
		const checkbox = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
		const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
		const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
		const text = (checkbox?.[2] ?? numbered?.[1] ?? bullet?.[1])?.trim();
		if (text) {
			ordinal += 1;
			current.steps.push({
				index: ordinal,
				text,
				done: checkbox ? checkbox[1].toLowerCase() === "x" : false,
				checkbox: checkbox != null,
			});
		}
	}
	pushCurrent();
	return sections;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Deliver review feedback to the agent: steer mid-turn, prompt when idle. */
async function sendPlanMessage(
	message: string,
	t: (key: string) => string,
	rpc: TabRpc,
	streaming: boolean,
): Promise<boolean> {
	const response = streaming ? await rpc.steer(message) : await rpc.prompt(message);
	if (!response.success) {
		toastError({ title: t("planPanel.feedbackFailed"), error: response });
		return false;
	}
	return true;
}

interface StepFeedbackState {
	step: PlanStep;
	draft: string;
	sending: boolean;
}

export function PlanDockCard({ presentation = "dock" }: { presentation?: "dock" | "panel" }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session");
	const { capture, isActive } = useTabGuard();
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const isStreaming = useSessionStore(s => s.isStreaming);
	// A pending proposal is answered on its own card; a second set of review buttons would compete with it.
	const proposalPending = usePlanApprovalStore(s => s.pending !== null);
	const [planFilePath, setPlanFilePath] = useState<string | null>(null);
	const [planFile, setPlanFile] = useState<string | null>(null);
	const [localRoot, setLocalRoot] = useState<string | null>(null);
	const [content, setContent] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	/** Localized sentence, plus the raw cause when a read failed. */
	const [error, setError] = useState<InlineFailure | null>(null);
	const [toggling, setToggling] = useState(false);
	const [tab, setTab] = useState<"steps" | "raw">("steps");
	const [approving, setApproving] = useState(false);
	const approvingRef = useRef(false);
	const [approvedContent, setApprovedContent] = useState<string | null>(null);
	const [planFeedback, setPlanFeedback] = useState("");
	const [sendingPlan, setSendingPlan] = useState(false);
	const [stepFeedback, setStepFeedback] = useState<StepFeedbackState | null>(null);

	const load = useCallback(
		async (options?: { quiet?: boolean }) => {
			const origin = capture();
			if (!origin) return;
			const quiet = options?.quiet === true;
			if (!quiet) setLoading(true);
			if (!quiet) setError(null);
			try {
				const modeResponse = await rpc.getPlanMode();
				if (!isActive(origin)) return;
				if (!modeResponse.success) {
					if (!quiet) setError(inlineFailure(modeResponse, t("planPanel.readFailed")));
					return;
				}
				const mode = modeResponse.data as PlanModeState | undefined;
				const path = mode?.planFilePath ?? null;
				setPlanFilePath(path);
				if (!path || (presentation === "dock" && !mode?.enabled)) {
					setPlanFile(null);
					setLocalRoot(null);
					setContent(null);
					return;
				}
				const { sessionFile, cwd } = sessionStore?.getState() ?? { sessionFile: null, cwd: "" };
				const resolved = resolvePlanFsPath(path, sessionFile, cwd);
				if (!resolved) {
					setPlanFile(null);
					setLocalRoot(null);
					setContent(null);
					if (!quiet) setError({ message: t("planPanel.noFsPath") });
					return;
				}
				const response = await window.omp.fs.readPlan({
					fsPath: resolved.fsPath,
					localRoot: resolved.localRoot,
					tabId: tabId ?? undefined,
				});
				if (!isActive(origin)) return;
				setLocalRoot(resolved.localRoot);
				if (!response.ok) {
					if (!quiet) setError(inlineFailure(response, t("planPanel.readFailed")));
					return;
				}
				if (response.path == null || response.content == null) {
					setPlanFile(null);
					setContent(null);
					return;
				}
				setPlanFile(response.path);
				setContent(response.content);
			} catch (cause) {
				if (isActive(origin) && !quiet) setError(inlineFailure(cause, t("planPanel.readFailed")));
			} finally {
				if (isActive(origin)) {
					setLoading(false);
					setLoaded(true);
				}
			}
		},
		[capture, isActive, rpc, t, sessionStore, tabId, presentation],
	);

	// Initial load + reset when plan mode flips.
	useEffect(() => {
		if (planModeEnabled || presentation === "panel") {
			void load();
		} else {
			setPlanFilePath(null);
			setPlanFile(null);
			setLocalRoot(null);
			setContent(null);
			setError(null);
			setLoaded(false);
			setStepFeedback(null);
		}
	}, [planModeEnabled, load, presentation]);

	// The agent writes the plan during its turn — refresh when a turn ends…
	const wasStreaming = useRef(isStreaming);
	useEffect(() => {
		const finished = wasStreaming.current && !isStreaming;
		wasStreaming.current = isStreaming;
		if (finished && planModeEnabled) void load({ quiet: true });
	}, [isStreaming, planModeEnabled, load]);

	// …and poll quietly while the planning turn streams so edits surface live.
	useEffect(() => {
		if (!isStreaming || !planModeEnabled) return;
		const timer = setInterval(() => void load({ quiet: true }), POLL_STREAMING_MS);
		return () => clearInterval(timer);
	}, [isStreaming, planModeEnabled, load]);

	const togglePlanMode = useCallback(async () => {
		const next = !(sessionStore?.getState().planModeEnabled ?? false);
		const origin = capture();
		if (!origin) return;
		setToggling(true);
		try {
			const response = await rpc.setPlanMode(next);
			if (!isActive(origin)) return; // switched tabs/sessions mid-request: never write A's result into B
			if (!response.success) {
				toastError({ title: t("planPanel.toggleFailed"), error: response });
				return;
			}
			const mode = response.data as PlanModeState | undefined;
			const enabled = mode?.enabled ?? next;
			sessionStore?.setState({ planModeEnabled: enabled });
			if (enabled) void load();
		} finally {
			setToggling(false);
		}
	}, [isActive, capture, load, rpc, t, sessionStore]);

	/** `local://<name>` when the file lives in the session-local root (how the agent refers to it). */
	const displayPath = useMemo(() => {
		if (planFile && localRoot && planFile.startsWith(`${localRoot}/`)) {
			return `local://${planFile.slice(localRoot.length + 1)}`;
		}
		return planFile ?? planFilePath;
	}, [planFile, localRoot, planFilePath]);

	const approve = useCallback(async () => {
		// One approval per plan: a second press before the first lands never sends a duplicate.
		if (approvingRef.current) return;
		approvingRef.current = true;
		const planText = content;
		setApproving(true);
		try {
			const target = displayPath ?? t("planPanel.fallbackTarget");
			const ok = await sendPlanMessage(t("planPanel.approveMessage", { target }), t, rpc, isStreaming);
			if (ok) {
				setApprovedContent(planText);
				toast({ variant: "success", message: t("planPanel.approvalSent") });
			}
		} finally {
			approvingRef.current = false;
			setApproving(false);
		}
	}, [content, displayPath, rpc, t, isStreaming]);

	const requestChanges = useCallback(async () => {
		const text = planFeedback.trim();
		if (!text) return;
		setSendingPlan(true);
		try {
			const target = displayPath ?? t("planPanel.fallbackTarget");
			const ok = await sendPlanMessage(
				t("planPanel.reviseMessage", { target, feedback: text }),
				t,
				rpc,
				isStreaming,
			);
			if (ok) setPlanFeedback("");
		} finally {
			setSendingPlan(false);
		}
	}, [planFeedback, displayPath, rpc, t, isStreaming]);

	const submitStepFeedback = useCallback(async () => {
		if (!stepFeedback) return;
		const text = stepFeedback.draft.trim();
		if (!text) return;
		setStepFeedback({ ...stepFeedback, sending: true });
		const target = displayPath ?? "the plan";
		const ok = await sendPlanMessage(
			`Feedback on plan step ${stepFeedback.step.index} — “${truncate(stepFeedback.step.text, 80)}” (${target}):\n${text}`,
			t,
			rpc,
			isStreaming,
		);
		if (ok) setStepFeedback(null);
		else setStepFeedback({ ...stepFeedback, sending: false });
	}, [stepFeedback, displayPath, rpc, t, isStreaming]);

	const sections = useMemo(() => parsePlanSections(content ?? ""), [content]);
	const stepCount = useMemo(() => sections.reduce((n, section) => n + section.steps.length, 0), [sections]);
	const doneCount = useMemo(
		() => sections.reduce((n, section) => n + section.steps.filter(step => step.done).length, 0),
		[sections],
	);
	const hasChecklist = useMemo(() => sections.some(s => s.steps.some(step => step.checkbox)), [sections]);

	const reviewable = planModeEnabled && content != null && content.trim().length > 0;
	// Approval covers this plan text; a rewritten plan is up for review again.
	const approved = approvedContent !== null && approvedContent === content;

	if (!planModeEnabled && presentation === "dock") return null;

	const Frame = presentation === "panel" ? PlanPanelFrame : DockCard;
	return (
		<Frame
			actions={
				<>
					<IconButton
						className={cx(loading && "[&>svg]:animate-spin motion-reduce:[&>svg]:animate-none")}
						disabled={loading}
						icon={<RefreshCw />}
						label={t("planPanel.refresh")}
						onClick={() => void load()}
						size="sm"
					/>
					<Switch
						checked={planModeEnabled}
						disabled={toggling}
						label={t("planPanel.toggle")}
						onCheckedChange={() => void togglePlanMode()}
						size="sm"
						title={t("planPanel.exit")}
					/>
				</>
			}
			badge={
				<span className="flex shrink-0 items-center gap-1.5">
					{stepCount > 0 && (
						<span className="tabular-nums">{hasChecklist ? `${doneCount}/${stepCount}` : stepCount}</span>
					)}
					<Badge dot pulse={isStreaming} variant="accent">
						{t("planPanel.badge.on")}
					</Badge>
				</span>
			}
			icon={ClipboardList}
			id="plan"
			title={t("dock.plan")}
		>
			{loading && !loaded ? (
				<div className="flex items-center justify-center py-6">
					<Spinner />
				</div>
			) : error ? (
				<div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
					<FileWarning aria-hidden="true" className="text-(--sc-warning)" size={20} />
					<div className="text-sc-sm leading-snug text-(--sc-text-muted)">{error.message}</div>
					<ErrorDetail error={error.cause} />
					<Button onClick={() => void load()} size="sm">
						{t("common.retry")}
					</Button>
				</div>
			) : content == null ? (
				presentation === "panel" ? (
					<EmptyState icon={<ClipboardList />} size="sm" title={t("planPanel.emptyTitle")} />
				) : (
					<div className="flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
						<ClipboardList aria-hidden="true" className="text-(--sc-text-subtle)" size={20} />
						<div className="text-sc-md font-medium text-(--sc-text)">{t("planPanel.emptyTitle")}</div>
						<div className="text-sc-sm leading-snug text-(--sc-text-muted)">{t("planPanel.emptyDesc")}</div>
						{displayPath && (
							<div
								className="max-w-full truncate font-mono text-sc-2xs text-(--sc-text-subtle)"
								title={displayPath}
							>
								{displayPath}
							</div>
						)}
					</div>
				)
			) : (
				<>
					<Tabs
						activeId={tab}
						ariaLabel={t("planPanel.tabsAria")}
						className="mx-2 mt-2"
						compact
						onChange={id => setTab(id as "steps" | "raw")}
						tabs={[
							{ id: "steps", label: t("planPanel.tabs.steps"), badge: stepCount > 0 ? stepCount : undefined },
							{ id: "raw", label: t("planPanel.tabs.raw") },
						]}
					/>
					<div className="px-2 py-1.5">
						{tab === "raw" ? (
							<MarkdownRenderer content={content} />
						) : sections.length === 0 ? (
							<div className="px-2 py-4 text-center text-sc-sm text-(--sc-text-muted)">
								{content.trim().length === 0 ? t("planPanel.emptySoFar") : t("planPanel.noSteps")}
							</div>
						) : (
							<>
								{hasChecklist && (
									<div className="px-1 pb-1 text-sc-2xs tabular-nums text-(--sc-text-muted)">
										{t("planPanel.checked", { done: doneCount, total: stepCount })}
									</div>
								)}
								{sections.map((section, sectionIndex) => (
									<section className="mb-1.5" key={sectionIndex}>
										{section.heading && (
											<div
												title={section.heading}
												className="truncate px-1 py-1 text-sc-sm font-medium text-(--sc-text-secondary)"
											>
												{section.heading}
											</div>
										)}
										<div className="ml-1 border-l border-(--sc-border-subtle) pl-2">
											{section.steps.map(step => (
												<div key={step.index}>
													<div className="group flex items-start gap-1.5 rounded-(--sc-radius-sm) py-1 pr-1 hover:bg-(--sc-hover)">
														{step.checkbox ? (
															step.done ? (
																<CheckCircle2
																	className="mt-0.5 shrink-0 text-(--sc-success)"
																	size={14}
																/>
															) : (
																<Circle className="mt-0.5 shrink-0 text-(--sc-text-subtle)" size={14} />
															)
														) : (
															<span className="w-4 shrink-0 pt-px text-right text-sc-2xs tabular-nums text-(--sc-text-muted)">
																{step.index}
															</span>
														)}
														<span
															className={cx(
																"min-w-0 flex-1 break-words text-sc-md leading-snug",
																step.done ? "text-(--sc-text-muted) line-through" : "text-(--sc-text)",
															)}
														>
															{step.text}
														</span>
														<IconButton
															className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
															icon={<MessageSquare />}
															label={t("planPanel.stepFeedbackAria", { index: step.index })}
															onClick={() => setStepFeedback({ step, draft: "", sending: false })}
															size="sm"
														/>
													</div>
													{stepFeedback?.step.index === step.index && (
														<div className="mb-1 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-transparent p-1.5">
															<TextArea
																aria-label={t("planPanel.stepFeedbackPlaceholder", {
																	index: step.index,
																})}
																autoFocus
																onChange={event =>
																	setStepFeedback({ ...stepFeedback, draft: event.target.value })
																}
																placeholder={t("planPanel.stepFeedbackPlaceholder", {
																	index: step.index,
																})}
																rows={2}
																value={stepFeedback.draft}
															/>
															<div className="mt-1 flex gap-1">
																<Button
																	disabled={!stepFeedback.draft.trim()}
																	icon={<Send />}
																	loading={stepFeedback.sending}
																	onClick={() => void submitStepFeedback()}
																	size="sm"
																	variant="secondary"
																>
																	{t("planPanel.send")}
																</Button>
																<Button onClick={() => setStepFeedback(null)} size="sm" variant="ghost">
																	{t("common.cancel")}
																</Button>
															</div>
														</div>
													)}
												</div>
											))}
										</div>
									</section>
								))}
							</>
						)}
					</div>

					{/* Review footer: approve / request changes, all as chat messages. */}
					{!proposalPending && (
						<div className="shrink-0 border-t border-(--sc-border-subtle) p-2">
							<TextArea
								aria-label={t("planPanel.feedbackPlaceholder")}
								disabled={!reviewable}
								onChange={event => setPlanFeedback(event.target.value)}
								placeholder={t("planPanel.feedbackPlaceholder")}
								rows={2}
								value={planFeedback}
							/>
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
								{approved ? (
									<span
										role="status"
										className="inline-flex min-h-(--sc-control-sm) items-center gap-1.5 px-1 text-sc-sm font-medium text-(--sc-text-secondary)"
									>
										<CheckCircle2 aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-success)" />
										{t("planPanel.approved")}
									</span>
								) : (
									<Button
										disabled={!reviewable}
										icon={<CheckCircle2 />}
										loading={approving}
										onClick={() => void approve()}
										size="sm"
										variant="primary"
									>
										{t("planPanel.approve")}
									</Button>
								)}
								<Button
									disabled={!reviewable || !planFeedback.trim()}
									loading={sendingPlan}
									onClick={() => void requestChanges()}
									size="sm"
								>
									{t("planPanel.requestChanges")}
								</Button>
							</div>
							<div className="mt-1.5 text-sc-2xs leading-snug text-(--sc-text-muted)">
								{t("planPanel.footerNote")}
							</div>
						</div>
					)}
				</>
			)}
		</Frame>
	);
}

/** Reuse the dock's stock plan data and review actions without duplicate polling logic. */
function PlanPanelFrame({ actions, children }: ComponentProps<typeof DockCard>) {
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-2">
			<PanelActions>{actions}</PanelActions>
			{children}
		</div>
	);
}
