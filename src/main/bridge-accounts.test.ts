import { describe, expect, it } from "vitest";
import { matchReportAccount, type StoredAccount } from "../../resources/gui-bridge/accounts-core";

const first: StoredAccount = { credentialId: 1, active: true };
const second: StoredAccount = { credentialId: 2, active: false };
describe("stock account candidate reconciliation", () => {
	it("only attributes a unique stock match", () => {
		expect(matchReportAccount({}, [first, second], 2, (_report, account) => account === second)).toBe(second);
		expect(matchReportAccount({}, [first, second], 2, () => true)).toBeUndefined();
		expect(matchReportAccount({}, [first, second], 2, () => false)).toBeUndefined();
	});
	it("keeps only the single-account single-report fallback", () => {
		expect(matchReportAccount({}, [first], 1, () => false)).toBe(first);
		expect(matchReportAccount({}, [first], 2, () => false)).toBeUndefined();
	});
});
