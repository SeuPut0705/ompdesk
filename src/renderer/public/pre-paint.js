/**
 * Pre-paint theme script — loaded synchronously from <head>, BEFORE any
 * module. The prefs IPC that resolves the real theme is async, so without
 * this every cold start painted the light default first: a white flash for
 * dark-theme users. Mirrors the scheme written by lib/themes.ts
 * (applyThemeByName → localStorage "omp.themeScheme").
 */
(function () {
	try {
		var scheme = localStorage.getItem("omp.themeScheme");
		if (scheme === "system") {
			scheme =
				window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light";
		}
		if (scheme === "dark" || scheme === "light") {
			document.documentElement.dataset.theme = scheme;
			document.documentElement.style.backgroundColor = scheme === "dark" ? "#191b1f" : "#fcfcfb";
			document.documentElement.style.colorScheme = scheme;
		}
	} catch (e) {
		/* no localStorage — the light default background stands */
	}
})();
