/**
 * The inline title editor of a sidebar session row. Saves on Enter or blur like the title bar's; the auto button
 * asks the omp of the tab that holds the session for a fresh title (`regenerate_session_title`). A stored session no
 * tab has open has no omp to ask, so its button is disabled and says why: the bridge that tracks a title's origin
 * (automatic or typed) lives in that omp, and a short-lived `omp` spawned for one click could neither keep the
 * origin nor be cancelled.
 */
import { useCallback, useRef } from "react";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { useAutoTitle } from "../../../hooks/use-auto-title";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { onEscape } from "../../../lib/keymap";
import { Input } from "../../common";
import { AutoTitleButton } from "../../common/AutoTitleButton";

interface SidebarRenameFieldProps {
	value: string;
	onChange(value: string): void;
	/** Enter or blur with the field's current text. */
	onCommit(value: string, via: "enter" | "blur"): void;
	onCancel(): void;
	/** The tab that holds the session; undefined for a stored session nothing has open. */
	tabId: string | undefined;
	/** The omp saved this title: the row only has to show it and close. */
	onGenerated(title: string): void;
}

export function SidebarRenameField({
	value,
	onChange,
	onCommit,
	onCancel,
	tabId,
	onGenerated,
}: SidebarRenameFieldProps) {
	const t = useT();
	const regenerate = useCallback(
		(): Promise<RpcResponse> =>
			tabId === undefined
				? Promise.reject(new Error("no tab"))
				: window.omp.rpc.commandForTab(tabId, { type: "regenerate_session_title" }),
		[tabId],
	);
	const autoTitle = useAutoTitle(regenerate);
	// Once the omp saved a title the field is done: a blur on its way out must not save the draft over it.
	const generated = useRef(false);
	const generate = async () => {
		const title = await autoTitle.run();
		if (!title) return;
		generated.current = true;
		onGenerated(title);
	};
	return (
		<Input
			aria-label={t("sidebar.rename")}
			autoFocus
			controlSize="sm"
			error={autoTitle.error ?? undefined}
			onBlur={event => {
				if (!generated.current) onCommit(event.currentTarget.value, "blur");
			}}
			onChange={event => {
				onChange(event.target.value);
				autoTitle.clearError();
			}}
			onFocus={event => event.currentTarget.select()}
			onKeyDown={event => {
				if (isImeKeyEvent(event)) return;
				// The field unmounts on Enter/Escape: hand focus back to the row. The
				// Enter is spent here, so it must not go on to press the row it lands on.
				if (event.key === "Enter") {
					event.preventDefault();
					onCommit(event.currentTarget.value, "enter");
				}
				onEscape(event, onCancel);
			}}
			readOnly={autoTitle.pending}
			trailing={
				<AutoTitleButton
					onClick={() => void generate()}
					pending={autoTitle.pending}
					unavailableReason={tabId === undefined ? t("titleAuto.needsTab") : undefined}
				/>
			}
			value={value}
		/>
	);
}
