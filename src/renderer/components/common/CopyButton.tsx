/**
 * CopyButton — the one clipboard action shown as an icon.
 *
 * A successful copy swaps the icon to a success check for a moment and
 * announces "Copied" to screen readers; a failed one raises an error toast,
 * since nothing on screen would otherwise say the clipboard is unchanged.
 * `text` may be a function so a large value (a log, a patch) is only built
 * when the user clicks, or read then (a promise). Every other IconButton prop passes through.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyText, copyTextWhenRead, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { IconButton, type IconButtonProps } from "./IconButton";

/** How long the success check stays before the copy icon returns. */
const COPIED_MS = 1500;

export interface CopyButtonProps extends Omit<IconButtonProps, "icon" | "onClick" | "pressed"> {
	/** The text to copy, or a function that builds or reads it on click. */
	text: string | (() => string | Promise<string>);
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
					const value = typeof text === "function" ? text() : text;
					// A ready string is written at once, inside the click (WebKit allows a write only then).
					const written = typeof value === "string" ? copyText(value) : copyTextWhenRead(value);
					void written.then(ok => {
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
