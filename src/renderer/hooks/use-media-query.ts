import { useSyncExternalStore } from "react";

/** Live `window.matchMedia(query).matches`; false where matchMedia is unavailable (tests). */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		onChange => {
			if (typeof window.matchMedia !== "function") return () => {};
			const media = window.matchMedia(query);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		() => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
		() => false,
	);
}
