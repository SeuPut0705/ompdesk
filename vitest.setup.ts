// A write under the real ~/.omp, ~/.pi, ~/.config/omp or OMPdesk's userData fails the test.
import "./scripts/vitest-real-home-guard";
import { exitWhenParentGone } from "./scripts/vitest-orphan-guard";
import { SESSION_OWNED_ENV } from "./src/main/omp-launch";
import { loadLocale } from "./src/renderer/lib/i18n";
import { dropGitSelectors } from "./src/shared/git-env";

// Each worker too: a leaked GIT_DIR or its kin would send a test's temp-repo git to another repository
// (src/shared/git-env.ts).
dropGitSelectors();

// Nor the plumbing of the OMPdesk session a run is launched from (its bridge socket, computer-use engine, memory file,
// ...): a stock test's omp inherits `process.env`, and one left on that session's agent-desktop engine without the
// MCP server waited 10 s for it at its first prompt and built a different system prompt (src/main/omp-launch.ts).
for (const key of SESSION_OWNED_ENV) delete process.env[key];

// A worker whose run was killed ends itself instead of running on as an orphan (scripts/vitest-orphan-guard.ts).
exitWhenParentGone();

if (typeof navigator !== "undefined") {
	Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
	// Keymap defaults and shortcut labels follow navigator.platform; pin macOS so
	// the suite behaves the same on the Windows CI runner.
	Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
}

// The UI's strings are a chunk per language (src/renderer/lib/i18n.tsx); the entries load the current one before
// they render, and the tests have both from the start.
await Promise.all([loadLocale("en"), loadLocale("ko")]);
