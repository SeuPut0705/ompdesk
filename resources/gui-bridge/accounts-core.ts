/** GUI reconciliation around stock reportMatchesActiveAccount. */
export interface StoredAccount {
	credentialId: number;
	email?: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	/** Last use recorded on this session's pin; only on the `active` account. */
	lastUsedAtMs?: number;
}

export function matchReportAccount<T>(
	report: T,
	accounts: readonly StoredAccount[],
	providerReportCount: number,
	matches: (report: T, account: StoredAccount) => boolean,
): StoredAccount | undefined {
	const candidates = accounts.filter(account => matches(report, account));
	// Stock reportMatchesActiveAccount answers per identity; GUI attribution must be unique.
	if (candidates.length === 1) return candidates[0];
	// Stock has no report-to-credential reconciliation: one account / one report is unambiguous.
	if (candidates.length === 0 && accounts.length === 1 && providerReportCount === 1) return accounts[0];
	return undefined;
}
