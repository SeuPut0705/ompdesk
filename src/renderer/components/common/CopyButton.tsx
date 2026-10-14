/**
 * CopyButton — the one clipboard action shown as an icon.
 *
 * A successful copy swaps the icon to a success check for a moment and
 * announces "Copied" to screen readers; a failed one raises an error toast,
 * since nothing on screen would otherwise say the clipboard is unchanged.
 * `text` may be a function so a large value (a log, a patch) is only built
 * when the user clicks. Every other IconButton prop passes through.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { IconButton, type IconButtonProps } from "./IconButton";

/** How long the success check stays before the copy icon returns. */
const COPIED_MS = 1500;

export interface CopyButtonProps extends Omit<IconButtonProps, "icon" | "onClick" | "pressed"> {
	/** The text to copy, or a function that builds it on click. */
	text: string | (() => string);
	/** Localized sentence for the failure toast; defaults to the shared one. */
	failedMessage?: string;
}

export function CopyButton({ text, failedMessage, className, size = "sm", ...rest }: CopyButtonProps) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);

	return (
		<>
			<IconButton
				className={cx(copied && "text-(--sc-success) hover:text-(--sc-success)", className)}
				data-copied={copied || undefined}
				icon={copied ? <Check /> : <Copy />}
				onClick={() => {
					void copyText(typeof text === "function" ? text() : text).then(ok => {
						if (ok) setCopied(true);
						else toast({ variant: "error", message: failedMessage ?? t("common.copyFailed") });
					});
				}}
				size={size}
				{...rest}
			/>
			<span aria-live="polite" className="sr-only" role="status">
				{copied ? t("common.copied") : ""}
			</span>
		</>
	);
}
