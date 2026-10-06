/**
 * Tool-approval dialog. The sidecar routes tool approval through a plain
 * `select` extension-UI request with exactly ["Approve", "Deny"] options and
 * a title of the form "Allow tool: <name>\n<details>". This component gives
 * that prompt a dedicated surface: tool name, capability tier badge, and a
 * monospace args preview. Deny (or closing the dialog) answers confirmed:false.
 */

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { ExtensionUIRequest } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant, Button, Modal } from "../common";

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
		<Modal onClose={deny} open size="md" title={t("approval.title")}>
			<div className="flex flex-col">
				<div className="flex items-center gap-2.5">
					<ShieldAlert className="shrink-0 text-(--omp-warning)" size={18} />
					<span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-(--omp-text)">
						{toolName}
					</span>
					<Badge dot variant={tier.variant}>
						{t(tier.key)}
					</Badge>
				</div>
				<div className="mt-3 max-h-[45vh] overflow-y-auto rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg) p-3">
					{body ? (
						<pre className="font-mono text-omp-sm leading-[1.55] break-words whitespace-pre-wrap text-(--omp-muted)">
							{body}
						</pre>
					) : (
						<span className="text-omp-sm text-(--omp-dim) italic">{t("approval.noArgs")}</span>
					)}
				</div>
				<div className="mt-4 flex items-center justify-between gap-2">
					<span className="text-omp-xs text-(--omp-dim)">{t("approval.waiting")}</span>
					<div className="flex gap-2">
						<Button onClick={deny} size="md" variant="danger">
							{t("approval.deny")}
						</Button>
						<Button
							variant="primary"
							size="md"
							icon={<ShieldCheck size={13} />}
							onClick={() => onRespond({ value: "Approve" })}
						>
							{t("approval.approve")}
						</Button>
					</div>
				</div>
			</div>
		</Modal>
	);
}
