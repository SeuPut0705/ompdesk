/**
 * Inline error block with a copy button (mutation failures carry detail the
 * user may need to paste into a report). Used by the marketplaces rows and
 * the plugin detail sheet.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText, cx } from "../../../lib/format";
import { IconButton } from "../../common";

export function CopyableError({
	message,
	copyLabel,
	className,
}: {
	message: string;
	copyLabel: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1500);
		return () => window.clearTimeout(timer);
	}, [copied]);
	return (
		<div
			className={cx(
				"flex items-start gap-2 rounded-(--sc-radius-md) border border-[color-mix(in_srgb,var(--sc-danger)_28%,transparent)] bg-(--sc-danger-soft) px-3 py-2",
				className,
			)}
			role="alert"
		>
			<span className="min-w-0 flex-1 py-0.5 text-sc-sm break-words whitespace-pre-wrap text-(--sc-danger)">
				{message}
			</span>
			<IconButton
				className={cx("-my-1 -mr-1.5", copied && "text-(--sc-success)")}
				icon={copied ? <Check /> : <Copy />}
				label={copyLabel}
				onClick={() => {
					void copyText(message).then(ok => {
						if (ok) setCopied(true);
					});
				}}
				size="sm"
			/>
		</div>
	);
}
