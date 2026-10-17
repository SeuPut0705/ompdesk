/**
 * The right-side sheet showing one subagent's transcript — Agents › Live and
 * the sidebar's subagent rows open the same surface (the side panel's
 * Subagent view reuses its transcript and steer form). Render it inside the
 * subagent's session runtime so the transcript reads from the owning tab.
 * While the subagent runs, the footer steers it like stock's Agent Hub chat
 * (RPC `steer_subagent`): the message lands in its turn as a steer.
 */

import { ArrowUp } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { IconButton, Sheet } from "../common";
import { SubagentTranscript } from "./SubagentTranscript";
import { isLiveSubagentStatus, statusMeta, subagentPrimaryLabel } from "./subagent-graph";
import { useSubagentTranscript } from "./use-subagent-transcript";

export function SteerSubagentForm({ agent }: { agent: SubagentSnapshot }) {
	const t = useT();
	const rpc = useTabRpc();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const name = subagentPrimaryLabel(agent);
	const send = async () => {
		const message = text.trim();
		if (!message || sending) return;
		setSending(true);
		try {
			const response = await rpc.steerSubagent(agent.id, message);
			if (!response.success) {
				toastError({ title: t("subagent.steer.failed"), error: response });
				return;
			}
			setText("");
			toast({ variant: "success", message: t("subagent.steer.sent", { name }) });
		} catch (cause) {
			toastError({ title: t("subagent.steer.failed"), error: cause });
		} finally {
			setSending(false);
		}
	};
	const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || isImeKeyEvent(event.nativeEvent)) return;
		event.preventDefault();
		void send();
	};
	return (
		<form
			className="omp-subagent-steer w-full"
			data-subagent-steer
			onSubmit={event => {
				event.preventDefault();
				void send();
			}}
		>
			{/* The composer's own box and send button, compact: one field, one round send. */}
			<div className="omp-composer-box flex items-end gap-1.5 rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) py-1.5 pr-1.5 pl-3 shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)">
				<textarea
					aria-label={t("subagent.steer.label", { name })}
					className="omp-composer-input min-w-0 flex-1 resize-none self-center bg-transparent text-sc-md break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none"
					disabled={sending}
					onChange={event => setText(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={t("subagent.steer.placeholder")}
					rows={1}
					value={text}
				/>
				<IconButton
					className="omp-composer-action"
					disabled={text.trim() === ""}
					icon={<ArrowUp strokeWidth={2.25} />}
					label={t("subagent.steer.send")}
					loading={sending}
					tooltip={false}
					type="submit"
					variant="primary"
				/>
			</div>
		</form>
	);
}

/** Stock steers only a running subagent this session owns; an advisor is read-only. */
export function isSteerableSubagent(agent: SubagentSnapshot): boolean {
	return isLiveSubagentStatus(agent.status) && agent.kind !== "advisor";
}

/** The sheet's transcript: its own read of the subagent, so the sheet follows a running one too. */
function SheetTranscript({ agent }: { agent: SubagentSnapshot }) {
	const transcript = useSubagentTranscript(agent);
	return <SubagentTranscript agent={agent} transcript={transcript} />;
}

export function SubagentTranscriptSheet({ agent, onClose }: { agent: SubagentSnapshot | null; onClose: () => void }) {
	const t = useT();
	const steerable = agent !== null && isSteerableSubagent(agent);
	return (
		<Sheet
			bodyClassName="flex flex-col p-0"
			description={agent ? `${agent.agent} · ${t(statusMeta(agent.status).labelKey)}` : undefined}
			footer={steerable ? <SteerSubagentForm agent={agent} key={agent.id} /> : undefined}
			onClose={onClose}
			open={agent !== null}
			size="lg"
			title={agent ? subagentPrimaryLabel(agent) : ""}
		>
			{agent && <SheetTranscript agent={agent} key={agent.id} />}
		</Sheet>
	);
}
