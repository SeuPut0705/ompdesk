/**
 * Pre-paint theme script — loaded synchronously from <head>, BEFORE any
 * module. The prefs IPC that resolves the real theme is async, so without
 * this every cold start painted a default first: a flash of the wrong
 * scheme. Mirrors what lib/themes.ts (applyThemeByName → storePaint) leaves in
 * localStorage: "omp.themeScheme" (dark, light or system) and "omp.themePaint"
 * (the page background of the theme shown under each OS scheme, so a saved Nord
 * or Sepia paints its own color, not the OMPdesk default's). With nothing saved
 * here, the color-scheme query answers: main sets nativeTheme.themeSource to the
 * saved theme's scheme before any window opens (src/main/window-chrome.ts), so a
 * window whose renderer never picked a theme still paints the app's, not the OS's.
 * The same color goes into the page's theme-color metas, so an installed phone
 * page's status bar matches before React mounts. Fallback backgrounds are --sc-bg
 * from theme-dark.css / theme-light.css.
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
		var background = scheme === "dark" ? "#19191c" : "#ffffff";
		try {
			var paint = JSON.parse(localStorage.getItem("omp.themePaint") || "{}");
			if (paint && typeof paint[scheme] === "string" && /^#[0-9a-f]{6}$/i.test(paint[scheme])) {
				background = paint[scheme];
			}
		} catch (e) {
			/* unreadable paint record — the OMPdesk default stands */
		}
		document.documentElement.dataset.theme = scheme;
		document.documentElement.style.backgroundColor = background;
		document.documentElement.style.colorScheme = scheme;
		var metas = document.querySelectorAll('meta[name="theme-color"]');
		for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", background);
	} catch (e) {
		/* no localStorage — the stylesheet default stands */
	}
})();
