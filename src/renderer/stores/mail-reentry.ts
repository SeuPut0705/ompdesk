/**
 * The email accounts that need their password again (`MailAccount.needsReentry`: this computer's keychain would ask
 * for the login password, native-rust › S › The keychain on macOS), mirrored from main for the one notice that names
 * them (`MailReentryNotice`). The accounts are this computer's own, so a window and a paired phone page of it read
 * the same list; a page that may not read it (a phone without the extensions permission) simply has no notice.
 */
import { create } from "zustand";
import type { MailAccount } from "../../shared/mail-accounts";

interface MailReentryStore {
	/** The accounts that need re-entry, in list order. */
	accounts: MailAccount[];
	/** The notice was closed this run; a different set of accounts shows it again. */
	dismissedFor: string | null;
	/** An account the notice asked Settings to open for editing (its password field); cleared once opened. */
	editRequest: string | null;
	/** Reads the list from main. */
	refresh: () => Promise<void>;
	/** Adopts a list main just answered (Settings changed an account). */
	adopt: (accounts: readonly MailAccount[]) => void;
	dismiss: () => void;
	requestEdit: (id: string) => void;
	clearEditRequest: () => void;
}

const keyOf = (accounts: readonly MailAccount[]): string => accounts.map(account => account.id).join("\n");

export const useMailReentryStore = create<MailReentryStore>()((set, get) => ({
	accounts: [],
	dismissedFor: null,
	editRequest: null,
	refresh: async () => {
		try {
			get().adopt((await window.omp.mailAccounts.command({ action: "list" })).accounts);
		} catch {
			// Not allowed here, or main is not ready: no notice, the Settings list reports its own failure.
		}
	},
	adopt: accounts => set({ accounts: accounts.filter(account => account.needsReentry) }),
	dismiss: () => set(state => ({ dismissedFor: keyOf(state.accounts) })),
	requestEdit: id => set({ editRequest: id }),
	clearEditRequest: () => set({ editRequest: null }),
}));

/** The accounts to name, or none once the person closed the notice for exactly this set. */
export function useMailReentryAccounts(): MailAccount[] {
	const accounts = useMailReentryStore(state => state.accounts);
	const dismissedFor = useMailReentryStore(state => state.dismissedFor);
	return accounts.length > 0 && keyOf(accounts) === dismissedFor ? [] : accounts;
}
