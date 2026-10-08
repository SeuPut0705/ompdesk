import { describe, expect, it } from "vitest";
import {
	accountLabel,
	matchReportAccount,
	reportIdentity,
	type StoredAccount,
} from "../../resources/gui-bridge/accounts-core";

const work: StoredAccount = { credentialId: 1, email: "me@example.com", accountId: "acc-work", active: false };
const home: StoredAccount = { credentialId: 2, email: "home@example.com", accountId: "acc-home", active: true };
const teamA: StoredAccount = {
	credentialId: 3,
	email: "me@example.com",
	orgId: "org-a",
	orgName: "Team A",
	active: false,
};
const teamB: StoredAccount = {
	credentialId: 4,
	email: "me@example.com",
	orgId: "org-b",
	orgName: "Team B",
	active: false,
};

describe("reportIdentity", () => {
	it("reads trimmed string identity fields from report metadata", () => {
		expect(reportIdentity({ email: " me@example.com ", accountId: "acc", orgId: 5, endpoint: "x" })).toEqual({
			email: "me@example.com",
			accountId: "acc",
			orgId: undefined,
			orgName: undefined,
		});
		expect(reportIdentity(undefined)).toEqual({});
	});
});

describe("accountLabel", () => {
	it("names the org next to an email that holds two subscriptions", () => {
		expect(accountLabel(teamA)).toBe("me@example.com (Team A)");
		expect(accountLabel(work)).toBe("me@example.com");
		expect(accountLabel({ credentialId: 8 })).toBe("#8");
	});
});

describe("matchReportAccount", () => {
	it("gives each report its own account instead of the session's", () => {
		const accounts = [work, home];
		expect(matchReportAccount({ email: "me@example.com", accountId: "acc-work" }, accounts, 2)).toBe(work);
		expect(matchReportAccount({ email: "home@example.com" }, accounts, 2)).toBe(home);
	});

	it("matches the email case-insensitively", () => {
		expect(matchReportAccount({ email: "HOME@example.com" }, [work, home], 2)).toBe(home);
	});

	it("tells two orgs of one email apart by the org", () => {
		const accounts = [teamA, teamB];
		expect(matchReportAccount({ email: "me@example.com", orgId: "org-b" }, accounts, 2)).toBe(teamB);
		expect(matchReportAccount({ email: "me@example.com" }, accounts, 2)).toBeUndefined();
	});

	it("falls back to the only account when the provider has one report", () => {
		expect(matchReportAccount({}, [work], 1)).toBe(work);
		expect(matchReportAccount({}, [work], 2)).toBeUndefined();
		expect(matchReportAccount({ email: "other@example.com" }, [work, home], 2)).toBeUndefined();
	});
});
