/**
 * Tool-approval card for the sidecar's approval `select` (see
 * `isApprovalRequest`). It renders as the docked prompt card above the
 * composer (like the Claude app's permission prompt): tool name, capability
 * tier badge, a monospace args preview, then numbered choices. Focus lands on
 * the card, never on Approve; Deny (or Escape) answers "Deny".
 */

import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { APPROVAL_TITLE_PREFIX, type ApprovalSelect } from "../../stores/extension-ui";
import { Badge, type BadgeVariant } from "../common";
import { ChoiceList, PromptCard, TimeoutFooter } from "./PromptCard";

export type ApprovalResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

const READ_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"ls",
	"find",
	"lsp",
	"web_search",
	"inspect_image",
	"recall",
	"get_branch_messages",
]);

const WRITE_TOOLS = new Set([
	"edit",
	"write",
	"ast_edit",
	"apply_patch",
	"memory_edit",
	"retain",
	"reflect",
	"learn",
	"manage_skill",
	"set_session_name",
	"todo",
	"goal",
]);

/** Tier badge: read=green, write=yellow, exec=red (default tier is exec). */
function tierFor(toolName: string): { key: string; variant: BadgeVariant } {
	if (READ_TOOLS.has(toolName)) return { key: "approval.tier.read", variant: "success" };
	if (WRITE_TOOLS.has(toolName)) return { key: "approval.tier.write", variant: "warning" };
	return { key: "approval.tier.exec", variant: "error" };
}

/** How long the agent has waited on this approval, counted from its arrival (queued time included). */
function WaitedFor({ since }: { since: number }) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const elapsed = formatElapsed(now - since);
	if (!elapsed) return null;
	return (
		<span className="text-sc-xs tabular-nums text-(--sc-text-muted)" data-approval-waited>
			{t("approval.waitedFor", { time: elapsed })}
		</span>
	);
}

export function ApprovalDialog({
	request,
	onRespond,
	remaining,
	arrivedAt,
}: {
	request: ApprovalSelect;
	onRespond: (response: ApprovalResponse) => void;
	/** Milliseconds before omp stops waiting; null without a timeout. */
	remaining: number | null;
	arrivedAt: number | undefined;
}) {
	const t = useT();
	const { toolName, body } = useMemo(() => {
		const lines = request.title.split("\n");
		const first = lines[0] ?? "";
		const name = first.startsWith(APPROVAL_TITLE_PREFIX) ? first.slice(APPROVAL_TITLE_PREFIX.length).trim() : first;
		const rest = lines.slice(1).join("\n").trim();
		return { toolName: name || t("approval.unknownTool"), body: rest };
	}, [request.title, t]);

	const tier = tierFor(toolName);
	const deny = () => onRespond({ value: "Deny" });

	return (
		<PromptCard
			footer={
				<>
					<span className="text-sc-xs text-(--sc-text-muted)">{t("approval.waiting")}</span>
					<span className="flex items-center gap-3">
						{arrivedAt !== undefined && <WaitedFor since={arrivedAt} />}
						<TimeoutFooter remaining={remaining} />
					</span>
				</>
			}
			headerAside={
				<Badge dot variant={tier.variant}>
					{t(tier.key)}
				</Badge>
			}
			icon={ShieldAlert}
			iconClassName="text-(--sc-warning)"
			label={t("approval.title")}
			onCancel={deny}
			onDigit={n => {
				if (n === 1) onRespond({ value: "Approve" });
				else if (n === 2) deny();
			}}
		>
			<div className="mb-1 truncate font-mono text-sc-sm font-semibold">{toolName}</div>
			<div className="mb-2 max-h-[30vh] overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) px-3 py-2">
				{body ? (
					<pre className="font-mono text-sc-sm leading-(--sc-leading-normal) break-words whitespace-pre-wrap text-(--sc-text-secondary)">
						{body}
					</pre>
				) : (
					<span className="text-sc-sm text-(--sc-text-muted) italic">{t("approval.noArgs")}</span>
				)}
			</div>
			<ChoiceList
				choices={[
					{ key: "Approve", label: t("approval.approve") },
					{ key: "Deny", label: t("approval.deny"), tone: "danger" },
				]}
				onChoose={key => (key === "Approve" ? onRespond({ value: "Approve" }) : deny())}
			/>
		</PromptCard>
	);
}
