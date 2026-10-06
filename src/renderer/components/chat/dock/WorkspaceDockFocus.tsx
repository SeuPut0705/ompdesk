import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type WorkspaceDockFocusCard = "todo" | "agents";

interface WorkspaceDockFocusValue {
	managed: boolean;
	focusedCard: WorkspaceDockFocusCard | null;
	focusCard: (card: WorkspaceDockFocusCard) => void;
	clearFocus: () => void;
}

const WorkspaceDockFocusContext = createContext<WorkspaceDockFocusValue>({
	managed: false,
	focusedCard: null,
	focusCard: () => {},
	clearFocus: () => {},
});

/**
 * Local presentation state for the center dock. It deliberately stays out of
 * the persisted UI store: "view all" is a temporary zoom, while the existing
 * per-card collapsed state remains a durable user preference.
 */
export function WorkspaceDockFocusProvider({ children }: { children: ReactNode }) {
	const [focusedCard, setFocusedCard] = useState<WorkspaceDockFocusCard | null>(null);
	const focusCard = useCallback((card: WorkspaceDockFocusCard) => setFocusedCard(card), []);
	const clearFocus = useCallback(() => setFocusedCard(null), []);
	const value = useMemo<WorkspaceDockFocusValue>(
		() => ({
			managed: true,
			focusedCard,
			focusCard,
			clearFocus,
		}),
		[clearFocus, focusCard, focusedCard],
	);

	return <WorkspaceDockFocusContext.Provider value={value}>{children}</WorkspaceDockFocusContext.Provider>;
}

export function useWorkspaceDockFocus(): WorkspaceDockFocusValue {
	return useContext(WorkspaceDockFocusContext);
}
