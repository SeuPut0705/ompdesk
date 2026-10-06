import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BtwHistoryRecord, BtwHistoryTurn, RpcBtwFrame } from "../../../shared/rpc-types";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import { useTabCommand } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner, TextArea } from "../common";

/** Apply one frame to its record; `btw_record` replaces it (last one wins), `btw_delta` extends the latest answer. */
function applyBtwFrame(record: BtwHistoryRecord | undefined, frame: RpcBtwFrame): BtwHistoryRecord | undefined {
	if (frame.type === "btw_record") return frame.record;
	if (!record) return undefined;
	const latest: BtwHistoryTurn = record.followUps?.at(-1) ?? record;
	const patched = { ...latest, answer: latest.answer + frame.delta };
	if (!record.followUps?.length) return { ...record, ...patched };
	return { ...record, followUps: [...record.followUps.slice(0, -1), patched] };
}

export function BtwDialog() {
	const t = useT();
	const command = useTabCommand();
	const generation = useRef(0);
	/** Frames for records this dialog has not adopted yet; they can overtake the `btw` response across IPC. */
	const pending = useRef(new Map<string, RpcBtwFrame[]>());
	const activeId = useRef<string | null>(null);
	const [draft, setDraft] = useState("");
	const question = useUiStore(state => state.btwRequest);
	const closeStore = useUiStore(state => state.closeBtw);
	const [record, setRecord] = useState<BtwHistoryRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: changing the bound task invalidates the pending answer even if its question is identical.
	useEffect(() => {
		generation.current++;
		pending.current.clear();
		activeId.current = null;
		setRecord(null);
		setError(null);
		setStarting(false);
		setDraft(question ?? "");
		if (question === null) return;
		const unsubscribe = window.omp.events.onBtwFrame(frame => {
			if (!acceptsActiveTabEvents()) return;
			const id = frame.type === "btw_record" ? frame.record.id : frame.recordId;
			if (id === activeId.current) {
				setRecord(current => applyBtwFrame(current ?? undefined, frame) ?? current);
				return;
			}
			const buffered = pending.current.get(id);
			if (buffered) buffered.push(frame);
			else pending.current.set(id, [frame]);
		});
		return () => {
			generation.current++;
			unsubscribe();
		};
	}, [question, command]);

	const turn: BtwHistoryTurn | undefined = record ? (record.followUps?.at(-1) ?? record) : undefined;
	const running = starting || turn?.status === "running";

	const ask = async () => {
		if (!draft.trim() || running) return;
		const version = generation.current;
		activeId.current = null;
		pending.current.clear();
		setError(null);
		setRecord(null);
		setStarting(true);
		try {
			const response = await command({ type: "btw", question: draft.trim() });
			if (generation.current !== version) return;
			if (!response.success) throw new Error(response.error);
			// The sidecar's `btw` response carries the record it just checkpointed as running.
			const result = response.data as { record: BtwHistoryRecord };
			let adopted: BtwHistoryRecord | undefined = result.record;
			activeId.current = adopted.id;
			for (const frame of pending.current.get(adopted.id) ?? []) adopted = applyBtwFrame(adopted, frame);
			pending.current.clear();
			setRecord(adopted ?? null);
		} catch (cause) {
			if (generation.current === version) setError(String(cause));
		} finally {
			if (generation.current === version) setStarting(false);
		}
	};

	const cancel = (): void => {
		const id = activeId.current;
		if (!id || turn?.status !== "running") return;
		void command({ type: "btw_cancel", recordId: id }).catch(() => {});
	};

	const close = (): void => {
		cancel();
		closeStore();
	};

	const copyAnswer = async (): Promise<void> => {
		if (!turn?.answer.trim()) return;
		if (!(await copyText(turn.answer))) {
			toast({ variant: "error", message: t("btw.copyFailed") });
			return;
		}
		toast({ variant: "success", message: t("btw.copied") });
	};

	const failure = error ?? (turn?.status === "error" ? (turn.error ?? t("btw.failed")) : null);

	return (
		<Modal onClose={close} open={question !== null} size="lg" title={t("btw.title")}>
			<div className="mb-4 flex items-start gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-2.5 text-xs text-(--omp-dim)">
				<MessageCircleQuestion className="mt-0.5 shrink-0" size={14} />
				<TextArea
					aria-label={t("btw.title")}
					value={draft}
					onChange={event => setDraft(event.target.value)}
					disabled={running}
					rows={3}
				/>
			</div>
			{failure ? (
				<div className="rounded-lg border border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)] bg-transparent p-3 text-sm text-[var(--omp-error)]">
					{failure}
				</div>
			) : turn?.answer ? (
				<div className="max-h-[55vh] overflow-y-auto pr-1">
					<MarkdownRenderer content={turn.answer} />
					{turn.status === "cancelled" || turn.status === "interrupted" ? (
						<div className="mt-2 text-xs text-(--omp-dim)">{t("btw.cancelled")}</div>
					) : null}
				</div>
			) : running ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("btw.thinking")}
				</div>
			) : turn?.status === "cancelled" || turn?.status === "interrupted" ? (
				<div className="py-4 text-sm text-(--omp-dim)">{t("btw.cancelled")}</div>
			) : null}
			<div className="mt-5 flex justify-end gap-2 border-t border-(--omp-border-muted) pt-3">
				{running ? (
					<Button disabled={starting} onClick={cancel} size="sm" variant="secondary">
						{t("btw.cancel")}
					</Button>
				) : (
					<Button disabled={!draft.trim()} onClick={() => void ask()} size="sm">
						{t("btw.ask")}
					</Button>
				)}
				<Button
					disabled={running || !turn?.answer.trim()}
					onClick={() => void copyAnswer()}
					size="sm"
					variant="secondary"
				>
					{t("btw.copy")}
				</Button>
			</div>
		</Modal>
	);
}
