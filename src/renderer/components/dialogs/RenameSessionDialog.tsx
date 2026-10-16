import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Rename session dialog: single text input prefilled with the current
 * session name; submits via rpc.setSessionName and mirrors the result into
 * the session store (the sidecar does not push a name update by itself).
 */

import { useEffect, useId, useRef, useState } from "react";
import { useAutoTitle } from "../../hooks/use-auto-title";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal } from "../common";
import { AutoTitleButton } from "../common/AutoTitleButton";

export function RenameSessionDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const formId = useId();
	const open = useUiStore(state => state.renameDialogOpen);
	const close = useUiStore(state => state.closeRenameDialog);
	const sessionName = useSessionStore(state => state.sessionName);
	const sidecarReady = useSessionStore(state => state.status) === "ready";

	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const autoTitle = useAutoTitle(tabRpc.regenerateSessionTitle);

	useEffect(() => {
		if (!open) return;
		setName(sessionName ?? "");
		setSaving(false);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [open, sessionName]);

	const submit = async () => {
		const trimmed = name.trim();
		if (!sidecarReady || !trimmed || saving) return;
		setSaving(true);
		try {
			const response = await tabRpc.setSessionName(trimmed);
			if (!response.success) {
				toastError({ title: t("rename.failed"), error: response });
				return;
			}
			useSessionStore.setState({ sessionName: trimmed });
			close();
		} catch (error) {
			toastError({ title: t("rename.failed"), error });
		} finally {
			setSaving(false);
		}
	};

	// The omp saves the title it makes: the field only shows it, and the dialog is done.
	const regenerate = async () => {
		const title = await autoTitle.run();
		if (!title) return;
		setName(title);
		useSessionStore.setState({ sessionName: title });
		close();
	};

	return (
		<Modal
			open={open}
			onClose={close}
			title={t("rename.title")}
			size="sm"
			footer={
				<>
					<Button type="button" variant="secondary" onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button
						type="submit"
						form={formId}
						variant="primary"
						loading={saving}
						disabled={name.trim().length === 0 || !sidecarReady}
						title={!sidecarReady ? t("sidecar.notResponding") : undefined}
					>
						{t("rename.submit")}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="flex flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					ref={inputRef}
					label={t("rename.label")}
					placeholder={t("rename.placeholder")}
					value={name}
					onChange={event => {
						setName(event.target.value);
						autoTitle.clearError();
					}}
					maxLength={120}
					autoFocus
					error={autoTitle.error ?? undefined}
					readOnly={autoTitle.pending}
					trailing={
						<AutoTitleButton
							onClick={() => void regenerate()}
							pending={autoTitle.pending}
							unavailableReason={sidecarReady ? undefined : t("sidecar.notResponding")}
						/>
					}
				/>
			</form>
		</Modal>
	);
}
