/**
 * What this session's person sent while the link to the computer was down, waiting in the outbox (stores/outbox.ts)
 * until lib/outbox-delivery.ts sends it: "Will send when connected", then one chip per message or answer, oldest
 * first. A message's pencil puts it back in the field (ahead of any draft) and takes it out of the outbox, its × takes
 * it back for good; an answer's × takes it back and puts the question's card up again. One the computer refused says
 * why and offers to try again; what follows it waits until then.
 *
 * ONE 36 px row at the top of the composer box, like the paused queue (`ComposerRestoredQueue`): the chips scroll
 * sideways. Nothing is drawn while nothing waits.
 */
import { AlertTriangle, CloudOff, MessageCircleQuestion, Pencil, RotateCcw, Send, X } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { queueChipLabel } from "../../../lib/queue-chip";
import { type OutboxItem, outboxFor, outboxSession, useOutboxStore } from "../../../stores/outbox";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { pushTabExtensionUiRequest, useTabsStore } from "../../../stores/tabs";
import { IconButton, Tooltip } from "../../common";

function OutboxChip({ item, tabId, onSettled }: { item: OutboxItem; tabId: string; onSettled: () => void }) {
	const t = useT();
	const drop = useOutboxStore(state => state.drop);
	const patch = useOutboxStore(state => state.patch);
	const { send } = item;
	const text =
		send.kind === "message"
			? queueChipLabel(send.text, send.images.length)
			: t("outbox.answer", { summary: send.summary });
	const StateIcon =
		item.state === "failed"
			? AlertTriangle
			: item.state === "sending"
				? Send
				: send.kind === "answer"
					? MessageCircleQuestion
					: CloudOff;
	const stateWord =
		item.state === "failed" ? t("outbox.failed", { error: item.error ?? "" }) : t(`outbox.${item.state}`);
	return (
		<li
			className="inline-flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-full border border-(--sc-border-subtle) bg-(--sc-surface-2) pr-0.5 pl-2.5 text-sc-xs text-(--sc-text-secondary)"
			data-outbox-item
			data-outbox-state={item.state}
		>
			<Tooltip content={stateWord} describe={false}>
				<span
					className={`inline-flex shrink-0 ${item.state === "failed" ? "text-(--sc-warning)" : "text-(--sc-text-muted)"}`}
				>
					<StateIcon aria-hidden className="size-(--sc-icon-sm)" />
					<span className="sr-only">{stateWord}</span>
				</span>
			</Tooltip>
			<span className="min-w-0 truncate" title={text}>
				{text}
			</span>
			{item.state === "failed" && (
				<IconButton
					className="size-6 rounded-full"
					data-outbox-retry
					icon={<RotateCcw />}
					label={t("outbox.retry", { text })}
					onClick={() => patch(item.id, { state: "held", error: undefined })}
					size="sm"
				/>
			)}
			{send.kind === "message" && (
				<IconButton
					className="size-6 rounded-full"
					data-outbox-edit
					disabled={item.state === "sending"}
					icon={<Pencil />}
					label={t("outbox.edit", { text })}
					onClick={() => {
						drop(item.id);
						window.dispatchEvent(
							new CustomEvent("omp:fill-composer", {
								detail: { text: send.text, images: send.images, prepend: true, tabId },
							}),
						);
						onSettled();
					}}
					size="sm"
				/>
			)}
			<IconButton
				className="size-6 rounded-full"
				data-outbox-cancel
				disabled={item.state === "sending"}
				icon={<X />}
				label={t("outbox.cancel", { text })}
				onClick={() => {
					drop(item.id);
					// The question is open on the computer still: its card comes back to be answered again.
					if (send.kind === "answer" && send.request) pushTabExtensionUiRequest(send.tabId, send.request);
					onSettled();
				}}
				size="sm"
			/>
		</li>
	);
}

export function ComposerOutbox({ onSettled }: { onSettled: () => void }) {
	const t = useT();
	const tabId = useRuntimeTabId() ?? useTabsStore.getState().activeTabId;
	const session = useTabsStore(state => {
		const tab = state.tabs.find(entry => entry.id === tabId);
		return tab ? outboxSession(tab) : null;
	});
	const all = useOutboxStore(state => state.items);
	const saved = useOutboxStore(state => state.saved);
	const items = useMemo(() => (session ? outboxFor(all, session) : []), [all, session]);
	if (!tabId || items.length === 0) return null;
	return (
		<section
			aria-label={t("outbox.label")}
			className="omp-composer-outbox flex h-9 shrink-0 items-center gap-2 pr-2 pl-3 pt-1 [--hit-gap-x:8px] [--hit-gap-y:4px]"
			data-composer-outbox
		>
			<ul
				aria-label={t("outbox.label")}
				className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
			>
				<li className="inline-flex shrink-0 items-center gap-1.5 text-sc-xs" data-outbox-note>
					<CloudOff aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-warning)" />
					<span className="whitespace-nowrap text-(--sc-text-secondary)" role="status">
						{saved ? t("outbox.label") : t("outbox.notKept")}
					</span>
				</li>
				{items.map(item => (
					<OutboxChip item={item} key={item.id} onSettled={onSettled} tabId={tabId} />
				))}
			</ul>
		</section>
	);
}
