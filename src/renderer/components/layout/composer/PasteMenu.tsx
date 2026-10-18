/**
 * The large-paste choice above the composer (use-composer-paste.ts): the paste's size and a head/tail preview,
 * then how it goes in — inline marker, wrapped attachment block, saved file — or cancel.
 */
import type { RefObject } from "react";
import { useT } from "../../../lib/i18n";
import { Button } from "../../common";
import type { PendingPaste } from "./use-composer-paste";

export function PasteMenu({
	paste,
	menuRef,
	onInline,
	onWrap,
	onSaveFile,
	onCancel,
}: {
	paste: PendingPaste;
	menuRef: RefObject<HTMLDivElement | null>;
	onInline: () => void;
	onWrap: () => void;
	onSaveFile: () => void;
	onCancel: () => void;
}) {
	const t = useT();
	const title = t("input.paste.title", { lines: paste.lineCount, chars: paste.content.length });
	const lines = paste.content.split("\n");
	const preview =
		lines.length <= 6
			? paste.content
			: `${lines.slice(0, 3).join("\n")}\n${t("input.paste.moreLines", { count: lines.length - 5 })}\n${lines.slice(-2).join("\n")}`;
	return (
		<div
			ref={menuRef}
			role="dialog"
			aria-label={title}
			className="omp-pop-in absolute right-0 bottom-full left-0 z-(--sc-z-popover) mb-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-3 shadow-(--sc-shadow-md)"
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-sc-md font-medium text-(--sc-text)">{title}</span>
				<span className="shrink-0 text-sc-sm text-(--sc-text-muted)">{t("input.paste.hint")}</span>
			</div>
			<pre className="mt-2 max-h-32 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-divider) bg-(--sc-surface-1) px-2.5 py-2 font-mono text-sc-sm break-all whitespace-pre-wrap text-(--sc-text-secondary)">
				{preview}
			</pre>
			<div className="mt-3 flex flex-wrap gap-2">
				<Button onClick={onInline} size="sm" variant="primary">
					{t("input.paste.inline")}
				</Button>
				<Button onClick={onWrap} size="sm">
					{t("input.paste.wrap")}
				</Button>
				<Button onClick={onSaveFile} size="sm">
					{t("input.paste.saveFile")}
				</Button>
				<Button onClick={onCancel} size="sm" variant="ghost">
					{t("input.paste.cancel")}
				</Button>
			</div>
		</div>
	);
}
