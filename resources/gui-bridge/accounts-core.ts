/**
 * Provider accounts, pure half: which stored OAuth account a usage report
 * belongs to, and the label the GUI shows for it. Stock usage reports carry the
 * account's identity in `metadata` (email / accountId / orgId) but no
 * credential row id, so the report is matched back to the stored accounts the
 * same way stock matches the session's active identity
 * (`slash-commands/helpers/logout.ts`). No omp imports, no Bun globals: the
 * GUI's vitest exercises this file directly (src/main/bridge-accounts.test.ts).
 */

/** One stored OAuth account (stock `OAuthAccountSummary`, the fields used here). */
export interface StoredAccount {
	credentialId: number;
	email?: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	orgName?: string;
	/** The session's pinned (sticky) credential. */
	active: boolean;
}

/** Identity a usage report names in its metadata. */
export interface ReportIdentity {
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

export function reportIdentity(metadata: Readonly<Record<string, unknown>> | undefined): ReportIdentity {
	return {
		email: text(metadata?.email),
		accountId: text(metadata?.accountId),
		orgId: text(metadata?.orgId),
		orgName: text(metadata?.orgName),
	};
}

/** Stock `/logout` label: the base identity, plus the org when two subscriptions share one email. */
export function accountLabel(account: Omit<StoredAccount, "active">): string {
	const base =
		text(account.email) ?? text(account.accountId) ?? text(account.projectId) ?? `#${account.credentialId}`;
	const org = text(account.orgName) ?? text(account.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * The stored account a report belongs to, or `undefined` when the report's
 * identity does not single one out. An org named on both sides must agree
 * (one email can hold two subscriptions); the account id wins over the email.
 * A provider with exactly one stored account and one report needs no identity.
 */
export function matchReportAccount(
	identity: ReportIdentity,
	accounts: readonly StoredAccount[],
	providerReportCount: number,
): StoredAccount | undefined {
	const sameOrg = (account: StoredAccount) =>
		identity.orgId === undefined || account.orgId === undefined || account.orgId === identity.orgId;
	const email = identity.email?.toLowerCase();
	const byAccountId = identity.accountId
		? accounts.filter(account => sameOrg(account) && account.accountId === identity.accountId)
		: [];
	if (byAccountId.length === 1) return byAccountId[0];
	const byEmail = email
		? accounts.filter(account => sameOrg(account) && account.email?.toLowerCase() === email)
		: [];
	if (byAccountId.length > 1) {
		const both = byAccountId.filter(account => byEmail.includes(account));
		return both.length === 1 ? both[0] : undefined;
	}
	if (byEmail.length === 1) return byEmail[0];
	if (byEmail.length === 0 && accounts.length === 1 && providerReportCount === 1) return accounts[0];
	return undefined;
}
