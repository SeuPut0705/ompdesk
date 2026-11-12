/**
 * The last usage report this omp's bridge read per stored account (`provider\0credentialId`), written by every
 * accounts and usage read in settings.ts. Two readers: the GUI shows it when stock has none (`showReport`), and a
 * reset pass the person confirmed is spent from it when the provider turns the live check away (reset-passes.ts).
 * Its own module, so the redeem reads it without loading the settings area.
 *
 * Beside it, the credits only a report's `raw` names (account-credits.ts `rawCredits`): stock hands `raw` to the
 * caller of the fetch and never caches it, so they are kept from the last fetch that passed through here.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { AccountCredits } from "../../src/shared/rpc-types";
import { creditsInRaw, rawCredits } from "./account-credits";

/**
 * Stock's `usage.invalidate` drops its own last-good copy, so an account whose refreshed probe the provider
 * rate-limits reads as no report until stock probes it again (pi-ai auth/usage-cache.ts `clearReports`; stock's
 * last-good retention, `USAGE_LAST_GOOD_RETENTION_MS`, covers only uninvalidated failures). The GUI shows this one
 * instead, with its own `fetchedAt`, so the age says how old it is; for at most {@link REPORT_RETAIN_MS}, and never
 * for an account that is gone. Stock's ranking keeps its own view.
 */
export const lastReports = new Map<string, UsageReport>();
const REPORT_RETAIN_MS = 10 * 60_000;

/** Per account: the credits its last fetched `raw` named, `null` when it named none. No entry: never fetched here. */
const fetchedCredits = new Map<string, AccountCredits | null>();

/** The report to show for one stored account: stock's, else the last one read while still recent. */
export function showReport(provider: string, credentialId: number, report: UsageReport | null): UsageReport | null {
	const key = `${provider}\0${credentialId}`;
	if (report) {
		lastReports.set(key, report);
		if (report.raw !== undefined && creditsInRaw(provider)) {
			fetchedCredits.set(key, rawCredits(provider, report.raw) ?? null);
		}
		return report;
	}
	const last = lastReports.get(key);
	return last && Date.now() - last.fetchedAt < REPORT_RETAIN_MS ? last : null;
}

/** The last report read for one stored account, however old (its `fetchedAt` says how old). */
export const lastReport = (provider: string, credentialId: number): UsageReport | undefined =>
	lastReports.get(`${provider}\0${credentialId}`);

/**
 * The credits the account's last fetch through this bridge named in its `raw`: `null` for none, `undefined` when no
 * fetch of it passed through here yet (stock's cache answered every read).
 */
export const lastFetchedCredits = (provider: string, credentialId: number): AccountCredits | null | undefined =>
	fetchedCredits.get(`${provider}\0${credentialId}`);
