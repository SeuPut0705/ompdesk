// A write under the real ~/.omp, ~/.pi, ~/.config/omp or OMPdesk's userData fails the test.
import "./scripts/vitest-real-home-guard";

if (typeof navigator !== "undefined") {
	Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
	// Keymap defaults and shortcut labels follow navigator.platform; pin macOS so
	// the suite behaves the same on the Windows CI runner.
	Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
}
