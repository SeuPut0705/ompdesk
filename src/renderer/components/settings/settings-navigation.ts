import { createContext, useContext } from "react";

/**
 * Settings page navigation for sections: go to `section[:sub]` and, when
 * given, scroll to and focus the row with id `focusRowId`.
 */
export type SettingsNavigate = (target: string, focusRowId?: string) => void;

const SettingsNavigationContext = createContext<SettingsNavigate | null>(null);
export const SettingsNavigationProvider = SettingsNavigationContext.Provider;

export function useSettingsNavigate(): SettingsNavigate {
	const navigate = useContext(SettingsNavigationContext);
	if (!navigate) throw new Error("useSettingsNavigate() outside SettingsPage");
	return navigate;
}
