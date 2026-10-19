/**
 * The inline rename field of a device row (paired computers, devices using this one, phone-page devices):
 * Enter or leaving the field saves a changed, non-empty name; Escape leaves it unchanged.
 */
import { useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { Input } from "../common";

export function DeviceNameField({
	name,
	onSave,
	onDone,
}: {
	name: string;
	onSave: (next: string) => void;
	onDone: () => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState(name);
	/** Escape leaves the field without saving; the blur that follows must not. */
	const cancelled = useRef(false);
	return (
		<Input
			aria-label={t("remote.host.name")}
			autoFocus
			controlSize="sm"
			data-device-rename
			maxLength={64}
			onBlur={event => {
				const next = event.currentTarget.value.trim();
				if (!cancelled.current && next && next !== name) onSave(next);
				onDone();
			}}
			onChange={event => setDraft(event.target.value)}
			onKeyDown={event => {
				if (isImeKeyEvent(event)) return;
				if (event.key === "Enter") event.currentTarget.blur();
				onEscape(event, () => {
					cancelled.current = true;
					onDone();
				});
			}}
			value={draft}
		/>
	);
}
