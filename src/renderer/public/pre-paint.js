/**
 * Pre-paint theme script — loaded synchronously from <head>, BEFORE any
 * module. The prefs IPC that resolves the real theme is async, so without
 * this every cold start painted a default first: a flash of the wrong
 * scheme. Mirrors the scheme written by lib/themes.ts (applyThemeByName →
 * localStorage "omp.themeScheme"); with nothing saved, seucode follows the OS.
 * Background colors are --sc-bg from theme-dark.css / theme-light.css.
 */
(function () {
	try {
		var scheme = localStorage.getItem("omp.themeScheme");
		if (scheme !== "dark" && scheme !== "light") {
			scheme =
				window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light";
		}
		document.documentElement.dataset.theme = scheme;
		document.documentElement.style.backgroundColor = scheme === "dark" ? "#19191c" : "#ffffff";
		document.documentElement.style.colorScheme = scheme;
	} catch (e) {
		/* no localStorage — the stylesheet default stands */
	}
})();
