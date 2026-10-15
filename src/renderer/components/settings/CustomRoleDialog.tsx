/**
 * Add or edit a custom model role. The id is the `modelRoles` key agents
 * select as `@id`, so it is chosen once (stock's rules: `customRoleIdError`);
 * the name and the description are what Settings shows.
 */

import { useState } from "react";
import { customRoleIdError } from "../../../../resources/gui-bridge/model-role-contracts";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal, TextArea } from "../common";

export interface CustomRoleFields {
	id: string;
	name: string;
	description: string;
}

interface Props {
	/** Set when editing: the id is fixed. */
	editing?: { id: string; title: string; name: string; description: string };
	/** Every role id Settings already lists. */
	knownIds: readonly string[];
	busy: boolean;
	onSubmit: (fields: CustomRoleFields) => void;
	onClose: () => void;
}

export function CustomRoleDialog({ editing, knownIds, busy, onSubmit, onClose }: Props) {
	const t = useT();
	const [id, setId] = useState(editing?.id ?? "");
	const [name, setName] = useState(editing?.name ?? "");
	const [description, setDescription] = useState(editing?.description ?? "");
	const idError = editing ? undefined : customRoleIdError(id, knownIds);
	const valid = editing !== undefined || (id.length > 0 && idError === undefined);
	const shownError = idError && idError !== "empty" ? t(`modelRoles.idError.${idError}`) : undefined;
	const submit = () => {
		if (valid && !busy) onSubmit({ id, name: name.trim(), description: description.trim() });
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={!valid || busy} loading={busy} onClick={submit} variant="primary">
						{editing ? t("common.save") : t("modelRoles.dialog.add")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="sm"
			title={editing ? t("modelRoles.dialog.editTitle", { role: editing.title }) : t("modelRoles.dialog.addTitle")}
		>
			<div className="space-y-3">
				{!editing && (
					<Input
						autoFocus
						autoCapitalize="none"
						autoComplete="off"
						error={shownError}
						hint={t("modelRoles.field.idHint")}
						label={t("modelRoles.field.id")}
						maxLength={32}
						mono
						name="role-id"
						onChange={event => setId(event.target.value)}
						spellCheck={false}
						value={id}
					/>
				)}
				<Input
					autoFocus={editing !== undefined}
					label={t("modelRoles.field.name")}
					maxLength={40}
					name="role-name"
					onChange={event => setName(event.target.value)}
					placeholder={editing?.title ?? t("modelRoles.field.namePlaceholder")}
					value={name}
				/>
				<TextArea
					label={t("modelRoles.field.description")}
					maxLength={240}
					name="role-description"
					onChange={event => setDescription(event.target.value)}
					placeholder={t("modelRoles.field.descriptionPlaceholder")}
					rows={2}
					value={description}
				/>
			</div>
		</Modal>
	);
}
