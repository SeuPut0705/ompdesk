/**
 * Add or edit one email account (Settings › Schedules › Email accounts): the IMAP server, who logs in and the folder an
 * email routine polls. The password is write-only: it is typed here, sent to main once and never shown again, so an
 * edit that leaves it empty keeps the stored one. Validation is the shared `mailAccountProblem`, the check main applies.
 */
import { useEffect, useId, useState } from "react";
import {
	MAIL_DEFAULT_MAILBOX,
	MAIL_DEFAULT_PORT,
	type MailAccount,
	type MailAccountDraft,
	mailAccountProblem,
} from "../../../shared/mail-accounts";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal } from "../common";

export function MailAccountDialog({
	open,
	account,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The account to edit; null adds one. */
	account: MailAccount | null;
	onClose: () => void;
	/** Resolves true once the account is stored; false keeps the dialog open (the failure is already shown). */
	onSave: (draft: MailAccountDraft) => Promise<boolean>;
}) {
	const t = useT();
	const formId = useId();
	const [label, setLabel] = useState("");
	const [host, setHost] = useState("");
	const [port, setPort] = useState(String(MAIL_DEFAULT_PORT));
	const [username, setUsername] = useState("");
	const [mailbox, setMailbox] = useState(MAIL_DEFAULT_MAILBOX);
	const [password, setPassword] = useState("");
	const [touched, setTouched] = useState(false);
	const [saving, setSaving] = useState(false);
	// Each opening starts from the account it edits, or a blank one; a typed password never outlives its dialog.
	useEffect(() => {
		if (!open) return;
		setLabel(account?.label ?? "");
		setHost(account?.host ?? "");
		setPort(String(account?.port ?? MAIL_DEFAULT_PORT));
		setUsername(account?.username ?? "");
		setMailbox(account?.mailbox ?? MAIL_DEFAULT_MAILBOX);
		setPassword("");
		setTouched(false);
	}, [open, account]);

	const keepsPassword = account?.hasPassword === true;
	const draft: MailAccountDraft = {
		label: label.trim(),
		host: host.trim(),
		port: port.trim() === "" ? Number.NaN : Number(port),
		username: username.trim(),
		mailbox: mailbox.trim(),
		...(password ? { password } : {}),
	};
	const problem = mailAccountProblem(draft, keepsPassword);
	const errorFor = (field: NonNullable<typeof problem>) =>
		touched && problem === field ? t(`mail.problem.${field}`) : undefined;

	const submit = async () => {
		setTouched(true);
		if (problem) return;
		setSaving(true);
		try {
			await onSave(draft);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button form={formId} loading={saving} type="submit" variant="primary">
						{account ? t("mail.save") : t("mail.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="sm"
			title={account ? t("mail.dialog.edit") : t("mail.dialog.new")}
		>
			<form
				className="flex flex-col gap-4"
				data-mail-account-form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					autoFocus
					error={errorFor("label")}
					label={t("mail.field.label")}
					maxLength={60}
					onChange={event => setLabel(event.target.value)}
					placeholder={t("mail.field.labelPlaceholder")}
					value={label}
				/>
				<div className="grid grid-cols-[minmax(0,1fr)_6rem] items-start gap-3">
					<Input
						autoCapitalize="off"
						autoCorrect="off"
						error={errorFor("host")}
						label={t("mail.field.host")}
						mono
						onChange={event => setHost(event.target.value)}
						placeholder="imap.example.com"
						spellCheck={false}
						value={host}
					/>
					<Input
						error={errorFor("port")}
						label={t("mail.field.port")}
						max={65_535}
						min={1}
						onChange={event => setPort(event.target.value)}
						type="number"
						value={port}
					/>
				</div>
				<Input
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					error={errorFor("username")}
					label={t("mail.field.username")}
					onChange={event => setUsername(event.target.value)}
					spellCheck={false}
					value={username}
				/>
				<Input
					autoComplete="new-password"
					error={errorFor("password")}
					hint={keepsPassword ? t("mail.field.passwordKeep") : undefined}
					label={t("mail.field.password")}
					maxLength={1000}
					onChange={event => setPassword(event.target.value)}
					type="password"
					value={password}
				/>
				<Input
					autoCapitalize="off"
					autoComplete="off"
					error={errorFor("mailbox")}
					label={t("mail.field.mailbox")}
					mono
					onChange={event => setMailbox(event.target.value)}
					spellCheck={false}
					value={mailbox}
				/>
			</form>
		</Modal>
	);
}
