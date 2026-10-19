import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Structured plan-approval card. The agent submits a plan by writing to
 * `xd://propose` while plan mode is active; the sidecar emits a
 * `plan_proposal` frame, silently stops the proposal turn, and waits for the
 * host's `plan_approval` answer. The card docks above the composer (like the
 * other agent prompts): the plan as scrollable markdown, then numbered
 * choices, one per advertised option:
 *
 * - execute      → planApproval(true, "execute")       (fresh session)
 * - compact      → planApproval(true, "compact")       (distill transcript first)
 * - keep_context → planApproval(true, "keep_context")  (intact transcript)
 * - save         → planApproval(true, "save", undefined, path) (host picks the path)
 * - refine       → planApproval(false, undefined, feedback) (re-plan with feedback)
 * - dismiss/Esc  → planApproval(false)                 (plain reject)
 *
 * Focus starts on the card, never on an approve row. Mirrors the TUI
 * plan-review overlay ("Approve and execute" / "Approve and compact context"
 * / "keep context" / "Refine plan"). Each visible runtime mounts its own card;
 * App owns the single all-tab plan-proposal subscription.
 */

import { ClipboardList } from "lucide-react";
import { useRef } from "react";
import { basename } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import {
	type PlanApprovalOption,
	type PlanApprovalSubmitState,
	usePlanApprovalStore,
} from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { settleTabPlanApproval } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { Spinner, TextArea } from "../common";
import { type Choice, ChoiceList, PromptCard } from "./PromptCard";

type SubmitKind = PlanApprovalSubmitState["kind"];

/** Wire result of the `plan_approval` command (RpcPlanApprovalResult). */
interface PlanApprovalResult {
	approved: boolean;
	dispatched: boolean;
	reason?: string;
	/** false when the rejection also ended plan mode (a plan the automatic choice used for one request). */
	planModeEnabled?: boolean;
	savedPath?: string;
	freshSessionStarted?: boolean;
}

const APPROVE_CHOICES: Record<PlanApprovalOption, { labelKey: string; hintKey: string }> = {
	execute: { labelKey: "planApproval.approve.execute.label", hintKey: "planApproval.approve.execute.hint" },
	compact: { labelKey: "planApproval.approve.compact.label", hintKey: "planApproval.approve.compact.hint" },
	keep_context: {
		labelKey: "planApproval.approve.keepContext.label",
		hintKey: "planApproval.approve.keepContext.hint",
	},
	save: { labelKey: "planApproval.approve.save.label", hintKey: "planApproval.approve.save.hint" },
};

/** Approve buttons from the advertised options; falls back to execute when none are recognizable. */
function approveOptionsOf(options: string[]): PlanApprovalOption[] {
	const known = options.filter(
		(option): option is PlanApprovalOption =>
			option === "execute" || option === "compact" || option === "keep_context" || option === "save",
	);
	return known.length > 0 ? known : ["execute"];
}

export function PlanApprovalDialog() {
	const tabRpc = useTabRpc();
	const originTabId = useRuntimeTabId();
	const originSessionId = useSessionStore(state => state.sessionId);
	const cwd = useSessionStore(state => state.cwd);
	const t = useT();
	const pending = usePlanApprovalStore(state => state.pending);
	const feedback = usePlanApprovalStore(state => state.feedback);
	const setFeedback = usePlanApprovalStore(state => state.setFeedback);
	const notice = usePlanApprovalStore(state => state.notice);
	const submitting = usePlanApprovalStore(state => state.submitting);
	const setSubmitting = usePlanApprovalStore(state => state.setSubmitting);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const feedbackRef = useRef<HTMLTextAreaElement>(null);

	if (!pending) return null;

	const respond = async (kind: SubmitKind, option?: PlanApprovalOption) => {
		if (!sidecarReady || submitting !== null) return;
		const target = pending;
		const trimmed = feedback.trim();
		const savePath =
			kind === "approve" && option === "save"
				? await window.omp.system.showSaveDialog(
						`${cwd}/${target.suggestedFileName ?? basename(target.planFilePath)}`,
						[{ name: "Markdown", extensions: ["md"] }],
					)
				: undefined;
		if (option === "save" && !savePath) return;
		setSubmitting(kind === "approve" ? { kind, option } : { kind });
		try {
			const response =
				kind === "approve"
					? option === "save"
						? await tabRpc.planApproval(true, option, undefined, savePath ?? undefined)
						: await tabRpc.planApproval(true, option)
					: kind === "refine"
						? await tabRpc.planApproval(false, undefined, trimmed)
						: await tabRpc.planApproval(false);
			if (!response.success) {
				// Answered first in another window, a device or by an agent: the card just closes.
				if (settleTabPlanApproval(originTabId, originSessionId, target, { submitting: null })) return;
				toastError({ title: t("planApproval.failed"), error: response });
				return;
			}
			const result = response.data as PlanApprovalResult | null | undefined;
			if (option === "save" && result?.savedPath) {
				settleTabPlanApproval(originTabId, originSessionId, target, { clear: true, exitPlanMode: true });
				toast({
					variant: result.freshSessionStarted === false ? "warning" : "success",
					message:
						result.freshSessionStarted === false
							? t("planApproval.savedWithoutFresh", {
									path: result.savedPath,
									reason: result.reason ?? t("common.unknownError"),
								})
							: t("planApproval.saved", { path: result.savedPath }),
				});
				return;
			}
			if (result && !result.dispatched) {
				if (kind === "approve") {
					// Approval stands but nothing was dispatched (e.g. compaction
					// failed) — surface the reason and stay open so the host can
					// pick another option.
					settleTabPlanApproval(originTabId, originSessionId, target, {
						exitPlanMode: true,
						notice: result.reason ?? t("planApproval.notDispatched"),
						submitting: null,
					});
					return;
				}
				// Plain reject / empty refine: resolved with nothing dispatched. A plan the automatic choice used for
				// this request ends with it (the bridge reports plan mode off).
				settleTabPlanApproval(originTabId, originSessionId, target, {
					clear: true,
					exitPlanMode: result.planModeEnabled === false,
				});
				return;
			}
			settleTabPlanApproval(originTabId, originSessionId, target, {
				clear: true,
				exitPlanMode: kind === "approve",
			});
			toast({
				variant: "success",
				message:
					kind === "approve"
						? t("planApproval.approved")
						: kind === "refine"
							? t("planApproval.refined")
							: t("planApproval.dismissed"),
			});
		} catch (cause) {
			if (settleTabPlanApproval(originTabId, originSessionId, target, { submitting: null })) return;
			toastError({ title: t("planApproval.failed"), error: cause });
		}
	};

	// Escape and the Dismiss row answer planApproval(false).
	const requestDismiss = () => {
		if (submitting !== null) return;
		void respond("dismiss");
	};

	const approveOptions = approveOptionsOf(pending.options);
	const showRefine = pending.options.length === 0 || pending.options.includes("refine");
	const busy = submitting !== null;
	const hasFeedback = feedback.trim().length > 0;
	const spinner = <Spinner size="sm" spin />;

	const choices: Choice[] = [
		...approveOptions.map(option => ({
			key: option,
			label: t(APPROVE_CHOICES[option].labelKey),
			description: t(APPROVE_CHOICES[option].hintKey),
			aside: submitting?.kind === "approve" && submitting.option === option ? spinner : undefined,
			disabled: !sidecarReady || busy,
		})),
		...(showRefine
			? [
					{
						key: "refine",
						label: t("planApproval.refine"),
						description: hasFeedback ? t("planApproval.refineTitle") : t("planApproval.refineNeedsFeedback"),
						aside: submitting?.kind === "refine" ? spinner : undefined,
						disabled: !sidecarReady || busy || !hasFeedback,
					},
				]
			: []),
		{ key: "dismiss", label: t("planApproval.dismiss"), disabled: !sidecarReady },
	];

	const choose = (key: string) => {
		if (key === "dismiss") {
			requestDismiss();
			return;
		}
		if (key === "refine") {
			// Refine needs feedback: picking it first moves into the field.
			if (hasFeedback) void respond("refine");
			else feedbackRef.current?.focus();
			return;
		}
		const option = approveOptions.find(candidate => candidate === key);
		if (option) void respond("approve", option);
	};

	return (
		<PromptCard
			footer={
				!sidecarReady ? (
					<span className="text-sc-xs text-(--sc-warning)">{t("sidecar.notResponding")}</span>
				) : undefined
			}
			icon={ClipboardList}
			label={pending.title ?? t("planApproval.reviewFallback")}
			onCancel={requestDismiss}
			onDigit={n => {
				const choice = choices[n - 1];
				if (choice && (!choice.disabled || choice.key === "refine")) choose(choice.key);
			}}
		>
			<div className="flex flex-col gap-2.5">
				<div className="flex items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<span className="shrink-0">{t("planApproval.planFile")}</span>
					<span className="truncate font-mono" title={pending.planFilePath}>
						{basename(pending.planFilePath)}
					</span>
				</div>
				<div
					className="max-h-[min(32vh,20rem)] overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2"
					data-plan-content
				>
					{pending.planContent.trim().length > 0 ? (
						<MarkdownRenderer content={pending.planContent} />
					) : (
						<p className="text-sc-sm text-(--sc-text-muted)">{t("planApproval.emptyPlan")}</p>
					)}
				</div>
				{notice !== null && (
					<div className="rounded-(--sc-radius-md) border border-(--sc-warning) px-3 py-2 text-sc-sm text-(--sc-warning)">
						{notice}
					</div>
				)}
				<ChoiceList choices={choices} onChoose={choose} />
				{showRefine && (
					<TextArea
						autoGrow
						className="max-h-[min(20vh,10rem)] overflow-y-auto"
						disabled={busy}
						hint={t("planApproval.refineHint")}
						label={t("planApproval.refineLabel")}
						maxLength={8000}
						onChange={event => setFeedback(event.target.value)}
						placeholder={t("planApproval.refinePlaceholder")}
						ref={feedbackRef}
						rows={2}
						value={feedback}
					/>
				)}
			</div>
		</PromptCard>
	);
}
