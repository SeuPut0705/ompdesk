/**
 * Inline error block with a copy button (mutation failures carry detail the
 * user may need to paste into a report). Used by the marketplaces cards and
 * the plugin detail drawer.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText, cx } from "../../../lib/format";

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
				"flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)] bg-transparent px-2.5 py-1.5",
				className,
			)}
		>
			<span className="min-w-0 flex-1 text-omp-sm break-words whitespace-pre-wrap text-(--omp-error)">
				{message}
			</span>
			<button
				aria-label={copyLabel}
				className="omp-pressable mt-px shrink-0 rounded p-0.5 text-(--omp-error) hover:brightness-110"
				onClick={() => {
					void copyText(message).then(ok => {
						if (ok) setCopied(true);
					});
				}}
				title={copyLabel}
				type="button"
			>
				{copied ? <Check size={11} className="text-(--omp-success)" /> : <Copy size={11} />}
			</button>
		</div>
	);
}
