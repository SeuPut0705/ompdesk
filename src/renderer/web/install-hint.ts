/**
 * The one quiet "install the app" hint: counted per browser session (a visit), shown on the second visit or
 * later, once ever, and only where the page has something to offer (a prompt or steps). It is a toast the person
 * can ignore or dismiss; its action starts the same install as the menu item. The memory is `localStorage`
 * (per device, like the install itself); a storage that throws (private mode) just means no hint.
 */
import { type InstallGuidance, type InstallHintRecord, installHintDue } from "./install";

export const INSTALL_HINT_KEY = "omp.web.install-hint";
const VISIT_COUNTED_KEY = "omp.web.install-hint.counted";

export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function readHintRecord(local: KeyValueStorage): InstallHintRecord {
	try {
		const parsed: unknown = JSON.parse(local.getItem(INSTALL_HINT_KEY) ?? "null");
		if (parsed && typeof parsed === "object") {
			const { visits, shown } = parsed as { visits?: unknown; shown?: unknown };
			return {
				visits: typeof visits === "number" && Number.isFinite(visits) && visits > 0 ? Math.floor(visits) : 0,
				shown: shown === true,
			};
		}
	} catch {
		// Unreadable memory is the same as none.
	}
	return { visits: 0, shown: false };
}

function writeHintRecord(local: KeyValueStorage, record: InstallHintRecord): void {
	try {
		local.setItem(INSTALL_HINT_KEY, JSON.stringify(record));
	} catch {
		// Quota or private mode: the hint just forgets.
	}
}

/** Counts this browser session as one visit (reloads and tabs of the same session count once). */
export function recordVisit(local: KeyValueStorage, session: KeyValueStorage): InstallHintRecord {
	const record = readHintRecord(local);
	try {
		if (session.getItem(VISIT_COUNTED_KEY) === "1") return record;
		session.setItem(VISIT_COUNTED_KEY, "1");
	} catch {
		return record;
	}
	const next = { ...record, visits: record.visits + 1 };
	writeHintRecord(local, next);
	return next;
}

export interface InstallHintDeps {
	local: KeyValueStorage;
	/** What the page offers right now (read when the hint is due, after the browser had time to fire its prompt). */
	guidance: () => InstallGuidance;
	show: (guidance: InstallGuidance) => void;
}

/** Shows the hint when it is due; returns whether it did. Marks it shown first, so a failure never repeats it. */
export function showInstallHintIfDue(deps: InstallHintDeps): boolean {
	const record = readHintRecord(deps.local);
	const guidance = deps.guidance();
	if (!installHintDue(record, guidance)) return false;
	writeHintRecord(deps.local, { ...record, shown: true });
	deps.show(guidance);
	return true;
}
