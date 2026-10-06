/**
 * Shared MCP feedback blocks: copy-to-clipboard button, copyable error box,
 * and the connection-test result view (success tool list / failure error).
 * Used by the add-server wizard pre-check and the server-card inline test.
 *
 * `summarizeMcpTestData` maps the raw mcp_test wire payload
 * ({ ok, toolNames?, toolCount?, error? }) onto a render-ready view model:
 * the first MCP_TEST_SHOWN_LIMIT tool names plus a "+N more" remainder that
 * also respects a toolCount larger than the returned name list.
 */

import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import { copyText, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Button, IconButton, Spinner } from "../../common";

/** Tool names rendered before the "+N more" remainder kicks in. */
export const MCP_TEST_SHOWN_LIMIT = 10;

/** Render-ready mapping of an mcp_test result payload. */
export type McpTestView =
	| { kind: "ok"; toolCount: number; shown: string[]; extra: number }
	| { kind: "error"; error: string };

/** Map a raw mcp_test `data` payload onto the inline result view model. */
export function summarizeMcpTestData(data: unknown): McpTestView {
	const payload = data as { ok?: boolean; toolNames?: string[]; toolCount?: number; error?: string } | undefined;
	if (payload?.ok !== true) {
		return { kind: "error", error: payload?.error ?? "" };
	}
	const names = payload.toolNames ?? [];
	const toolCount = payload.toolCount ?? names.length;
	const shown = names.slice(0, MCP_TEST_SHOWN_LIMIT);
	const extra = Math.max(0, Math.max(names.length, toolCount) - shown.length);
	return { kind: "ok", toolCount, shown, extra };
}

/** Small copy button with a transient check confirmation (CodeBlock pattern). */
export function CopyButton({ text, className }: { text: string; className?: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	return (
		<Button
			className={cx(copied && "text-(--sc-success)", className)}
			icon={copied ? <Check /> : <Copy />}
			onClick={() => {
				void copyText(text).then(ok => {
					if (!ok) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1400);
				});
			}}
			size="sm"
			variant="ghost"
		>
			{copied ? t("mcp.card.copied") : t("mcp.card.copy")}
		</Button>
	);
}

const DANGER_BOX =
	"rounded-(--sc-radius-md) border border-[color-mix(in_srgb,var(--sc-danger)_28%,transparent)] bg-(--sc-danger-soft) px-3 py-2";

/** Danger box whose message can be copied verbatim (server-side errors). */
export function CopyableError({ title, text, className }: { title?: string; text: string; className?: string }) {
	return (
		<div className={cx(DANGER_BOX, className)} role="alert">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					{title && <span className="mb-0.5 block text-sc-sm font-medium text-(--sc-danger)">{title}</span>}
					<span className="block font-mono text-sc-xs break-all whitespace-pre-wrap text-(--sc-text-secondary)">
						{text}
					</span>
				</div>
				<CopyButton className="-my-1" text={text} />
			</div>
		</div>
	);
}

/**
 * Inline connection-test result: spinner while running, tool list on success
 * (first MCP_TEST_SHOWN_LIMIT names as chips + "+N more"), copyable error on
 * failure. Optional dismiss for card-hosted results.
 */
export function McpTestResultView({
	testing,
	view,
	onDismiss,
	className,
}: {
	testing?: boolean;
	view: McpTestView | null;
	onDismiss?: () => void;
	className?: string;
}) {
	const t = useT();
	if (testing) {
		return (
			<div className={cx("flex items-center gap-2 py-1", className)}>
				<Spinner size="sm" />
				<span className="text-sc-sm text-(--sc-text-muted)">{t("mcp.wizard.testing")}</span>
			</div>
		);
	}
	if (!view) return null;
	const dismiss = onDismiss ? (
		<IconButton className="-my-1 -mr-1.5" icon={<X />} label={t("mcp.test.dismiss")} onClick={onDismiss} size="sm" />
	) : null;
	if (view.kind === "error") {
		return (
			<div className={cx(DANGER_BOX, className)}>
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						<span className="mb-0.5 block text-sc-sm font-medium text-(--sc-danger)">{t("mcp.test.failed")}</span>
						<span className="block font-mono text-sc-xs break-all whitespace-pre-wrap text-(--sc-text-secondary)">
							{view.error || t("mcp.test.unknownError")}
						</span>
					</div>
					{dismiss}
				</div>
			</div>
		);
	}
	return (
		<div
			className={cx(
				"rounded-(--sc-radius-md) border border-[color-mix(in_srgb,var(--sc-success)_28%,transparent)] bg-(--sc-success-soft) px-3 py-2",
				className,
			)}
		>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 text-sc-sm font-medium text-(--sc-success)">
					{view.toolCount > 0 ? t("mcp.test.ok", { count: view.toolCount }) : t("mcp.test.okNoTools")}
				</span>
				{dismiss}
			</div>
			{view.shown.length > 0 && (
				<div className="mt-1 flex flex-wrap items-center gap-1">
					{view.shown.map(name => (
						<code
							className="rounded-(--sc-radius-xs) bg-(--sc-surface-3) px-1.5 py-px font-mono text-sc-xs text-(--sc-text-secondary)"
							key={name}
						>
							{name}
						</code>
					))}
					{view.extra > 0 && (
						<span className="text-sc-xs text-(--sc-text-muted)">{t("mcp.test.more", { count: view.extra })}</span>
					)}
				</div>
			)}
		</div>
	);
}
