import { create } from "zustand";

interface StatsStore {
	data: Record<string, unknown>;
	activeRange: string;
	isLoading: boolean;
	error: string | null;
	setData: (key: string, data: unknown) => void;
	setRange: (range: string) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
}

export const useStatsStore = create<StatsStore>()((set, get) => ({
	data: {},
	activeRange: "session",
	isLoading: false,
	error: null,
	setData: (key, data) => set({ data: { ...get().data, [key]: data } }),
	setRange: range => set({ activeRange: range }),
	setLoading: loading => set({ isLoading: loading }),
	setError: error => set({ error }),
}));
