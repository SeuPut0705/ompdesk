/**
 * Tool-approval card. The sidecar routes tool approval through a plain
 * `select` extension-UI request with exactly ["Approve", "Deny"] options and
 * a title of the form "Allow tool: <name>\n<details>". It renders as the
 * docked prompt card above the composer (like the Claude app's permission
 * prompt): tool name, capability tier badge, a monospace args preview, then
 * numbered choices. Focus lands on the card, never on Approve; Deny (or
 * Escape) answers "Deny".
 */

import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import type { ExtensionUIRequest } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant } from "../common";
import { ChoiceList, PromptCard } from "./PromptCard";

const APPROVAL_TITLE_PREFIX = "Allow tool: ";

type ApprovalSelect = Extract<ExtensionUIRequest, { method: "select" }>;

export type ApprovalResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export function isApprovalRequest(request: ExtensionUIRequest): request is ApprovalSelect {
	return (
		request.method === "select" &&
		request.options.length === 2 &&
		request.options[0] === "Approve" &&
		request.options[1] === "Deny" &&
		request.title.startsWith(APPROVAL_TITLE_PREFIX)
	);
}

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

export function ApprovalDialog({
	request,
	onRespond,
}: {
	request: ApprovalSelect;
	onRespond: (response: ApprovalResponse) => void;
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
			footer={<span className="text-sc-xs text-(--sc-text-muted)">{t("approval.waiting")}</span>}
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
			<div className="mb-2 max-h-[30vh] overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--omp-code-bg) px-3 py-2">
				{body ? (
					<pre className="font-mono text-omp-sm leading-[1.55] break-words whitespace-pre-wrap text-(--sc-text-secondary)">
						{body}
					</pre>
				) : (
					<span className="text-omp-sm text-(--sc-text-muted) italic">{t("approval.noArgs")}</span>
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
