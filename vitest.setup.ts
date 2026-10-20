// A write under the real ~/.omp, ~/.pi, ~/.config/omp or OMPdesk's userData fails the test.
import "./scripts/vitest-real-home-guard";
import { loadLocale } from "./src/renderer/lib/i18n";
import { dropGitSelectors } from "./src/shared/git-env";

// Each worker too: a leaked GIT_DIR or its kin would send a test's temp-repo git to another repository
// (src/shared/git-env.ts).
dropGitSelectors();

if (typeof navigator !== "undefined") {
	Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
	// Keymap defaults and shortcut labels follow navigator.platform; pin macOS so
	// the suite behaves the same on the Windows CI runner.
	Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
}

// The UI's strings are a chunk per language (src/renderer/lib/i18n.tsx); the entries load the current one before
// they render, and the tests have both from the start.
await Promise.all([loadLocale("en"), loadLocale("ko")]);
