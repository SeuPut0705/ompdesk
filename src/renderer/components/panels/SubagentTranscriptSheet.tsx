/**
 * The right-side sheet showing one subagent's transcript — Agents › Live and
 * the sidebar's subagent rows open the same surface (the side panel's
 * Subagent view reuses its transcript and steer form). Render it inside the
 * subagent's session runtime so the transcript reads from the owning tab.
 * While the subagent runs, the footer steers it like stock's Agent Hub chat
 * (RPC `steer_subagent`): the message lands in its turn as a steer.
 */

import { CornerDownRight } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { Button, Sheet, TextArea } from "../common";
import { SubagentTranscript } from "./SubagentTranscript";
import { isLiveSubagentStatus, statusMeta, subagentPrimaryLabel } from "./subagent-graph";

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
			className="flex w-full items-end gap-2"
			data-subagent-steer
			onSubmit={event => {
				event.preventDefault();
				void send();
			}}
		>
			<TextArea
				aria-label={t("subagent.steer.label", { name })}
				autoGrow
				className="max-h-40 min-w-0 flex-1"
				disabled={sending}
				onChange={event => setText(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={t("subagent.steer.placeholder")}
				rows={1}
				value={text}
			/>
			<Button
				disabled={sending || text.trim() === ""}
				icon={<CornerDownRight aria-hidden />}
				size="sm"
				type="submit"
				variant="primary"
			>
				{t("subagent.steer.send")}
			</Button>
		</form>
	);
}

/** Stock steers only a running subagent this session owns; an advisor is read-only. */
export function isSteerableSubagent(agent: SubagentSnapshot): boolean {
	return isLiveSubagentStatus(agent.status) && agent.kind !== "advisor";
}

export function SubagentTranscriptSheet({ agent, onClose }: { agent: SubagentSnapshot | null; onClose: () => void }) {
	const t = useT();
	const steerable = agent !== null && isSteerableSubagent(agent);
	return (
		<Sheet
			description={agent ? `${agent.agent} · ${t(statusMeta(agent.status).labelKey)}` : undefined}
			footer={steerable ? <SteerSubagentForm agent={agent} key={agent.id} /> : undefined}
			onClose={onClose}
			open={agent !== null}
			size="lg"
			title={agent ? subagentPrimaryLabel(agent) : ""}
		>
			{agent && <SubagentTranscript agent={agent} />}
		</Sheet>
	);
}
