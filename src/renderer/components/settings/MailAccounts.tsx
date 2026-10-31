/**
 * Settings › Schedules › Email accounts: the mailboxes this computer's email routines poll over IMAP/TLS. Each row names
 * the account (label, `username @ host`, mailbox) with Test (logs in and opens the mailbox once, the answer stays on
 * the row), Edit and Remove. Main keeps the accounts and the encrypted passwords; a password is write-only, so nothing
 * here reads, shows or logs one. A tab on a paired host shows one line instead: its accounts are set on that computer.
 */
import { CheckCircle2, Mail, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
	MailAccount,
	MailAccountDraft,
	MailAccountsRequest,
	MailAccountTest,
} from "../../../shared/mail-accounts";
import { useT } from "../../lib/i18n";
import { toastError } from "../../stores/toast";
import { Banner, Button, ConfirmDialog, ErrorDetail, MenuButton, SkeletonRows } from "../common";
import { MailAccountDialog } from "./MailAccountDialog";
import { SettingsSection } from "./SettingsLayout";

/** A row's last test: running, or its answer. */
type RowTest = "testing" | MailAccountTest;

export function MailAccounts({ device }: { device: string | undefined }) {
	const t = useT();
	if (device !== undefined) {
		return (
			<SettingsSection id="settings-mail-accounts" title={t("mail.title")}>
				<p className="text-sc-xs text-(--sc-text-muted)" data-mail-elsewhere>
					{t("mail.elsewhere")}
				</p>
			</SettingsSection>
		);
	}
	return <LocalMailAccounts />;
}

function LocalMailAccounts() {
	const t = useT();
	const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [editing, setEditing] = useState<{ account: MailAccount | null } | null>(null);
	const [removing, setRemoving] = useState<MailAccount | null>(null);
	const [tests, setTests] = useState<Record<string, RowTest>>({});

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			setAccounts((await window.omp.mailAccounts.command({ action: "list" })).accounts);
		} catch (error) {
			setLoadError(error);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const send = async (request: Exclude<MailAccountsRequest, { action: "test" }>): Promise<boolean> => {
		try {
			setAccounts((await window.omp.mailAccounts.command(request)).accounts);
			return true;
		} catch (error) {
			toastError({ title: t("mail.actionFailed"), error });
			return false;
		}
	};
	const save = async (draft: MailAccountDraft): Promise<boolean> => {
		const id = editing?.account?.id;
		const saved = await send(id ? { action: "save", id, draft } : { action: "save", draft });
		if (saved) {
			if (id) setTests(({ [id]: _stale, ...rest }) => rest);
			setEditing(null);
		}
		return saved;
	};
	const test = async (id: string) => {
		setTests(current => ({ ...current, [id]: "testing" }));
		let result: MailAccountTest;
		try {
			result = await window.omp.mailAccounts.test(id);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		setTests(current => ({ ...current, [id]: result }));
	};

	if (!accounts) {
		return (
			<SettingsSection id="settings-mail-accounts" title={t("mail.title")}>
				{loadError ? (
					<Banner
						actions={
							<Button icon={<RefreshCw />} onClick={() => void load()} size="sm">
								{t("common.retry")}
							</Button>
						}
						live
						title={t("mail.loadFailed")}
						variant="danger"
					>
						<ErrorDetail error={loadError} />
					</Banner>
				) : (
					<SkeletonRows label={t("mail.loading")} widths={[58, 44]} />
				)}
			</SettingsSection>
		);
	}

	return (
		<>
			<SettingsSection
				actions={
					<Button
						data-mail-account-new
						icon={<Plus />}
						onClick={() => setEditing({ account: null })}
						size="sm"
						variant="secondary"
					>
						{t("mail.add")}
					</Button>
				}
				id="settings-mail-accounts"
				title={t("mail.title")}
			>
				{accounts.length === 0 ? (
					<p className="py-1 text-sc-sm text-(--sc-text-muted)" data-mail-empty>
						{t("mail.empty")}
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-(--sc-divider)" data-mail-accounts>
						{accounts.map(account => {
							const result = tests[account.id];
							return (
								<li className="flex items-center gap-2 py-1.5" data-mail-account={account.id} key={account.id}>
									<Mail aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
									<div className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-sc-md font-medium text-(--sc-text)">{account.label}</span>
										<span
											className="truncate text-sc-xs text-(--sc-text-muted)"
											title={`${account.username} @ ${account.host}:${account.port}`}
										>
											{account.username} @ {account.host} · {account.mailbox}
										</span>
										{result && result !== "testing" && (
											<span
												className={`flex min-w-0 items-start gap-1 text-sc-xs break-words ${result.ok ? "text-(--sc-success)" : "text-(--sc-danger)"}`}
												data-mail-test-result
												role="status"
											>
												{result.ok ? (
													<CheckCircle2 aria-hidden className="mt-px size-(--sc-icon-sm) shrink-0" />
												) : (
													<XCircle aria-hidden className="mt-px size-(--sc-icon-sm) shrink-0" />
												)}
												<span className="min-w-0">
													{result.ok
														? t(result.messages === 1 ? "mail.test.okOne" : "mail.test.ok", {
																count: result.messages,
															})
														: result.error}
												</span>
											</span>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-0.5">
										<Button
											aria-label={t("mail.testAccount", { name: account.label })}
											data-mail-test
											loading={result === "testing"}
											onClick={() => void test(account.id)}
											size="sm"
											variant="ghost"
										>
											{t("mail.test")}
										</Button>
										<MenuButton
											align="end"
											icon={<MoreHorizontal />}
											items={[
												{
													id: "edit",
													label: t("mail.edit"),
													icon: Pencil,
													onSelect: () => setEditing({ account }),
												},
												{
													id: "remove",
													label: t("mail.remove"),
													icon: Trash2,
													danger: true,
													onSelect: () => setRemoving(account),
												},
											]}
											label={t("mail.menu", { name: account.label })}
											size="sm"
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
				<p className="text-sc-xs text-(--sc-text-muted)" data-mail-note>
					{t("mail.note")}
				</p>
			</SettingsSection>

			<MailAccountDialog
				account={editing?.account ?? null}
				onClose={() => setEditing(null)}
				onSave={save}
				open={editing !== null}
			/>
			<ConfirmDialog
				confirmLabel={t("mail.remove")}
				message={t("mail.removeMessage", { name: removing?.label ?? "" })}
				onCancel={() => setRemoving(null)}
				onConfirm={() => {
					const target = removing;
					setRemoving(null);
					if (target) void send({ action: "remove", id: target.id });
				}}
				open={removing !== null}
				title={t("mail.removeTitle")}
			/>
		</>
	);
}
