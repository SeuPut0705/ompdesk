/**
 * Which changed files `check:changed` checks, and how (scripts/check-changed.ts). Source lives under `src/`, `e2e/`,
 * `resources/` and `scripts/`; the repository's root configuration decides how all of it is typed, linted, built and
 * tested, so a change there is checked too instead of reading as "nothing changed": the typecheck and biome always, the
 * build for a build input, and the whole vitest run for what decides which tests run and how (`vitest related` finds no
 * test through a config file).
 */

const SOURCE = /^(?:src|e2e|resources|scripts)\//;
const ROOT_CONFIG =
	/^(?:[^/]+\.config\.[cm]?ts|vitest[^/]*\.[cm]?ts|tsconfig[^/]*\.json|package\.json|bun\.lock|bunfig\.toml|biome\.jsonc?)$/;
/** Root files the build reads (`scripts/build-cache.ts` hashes these too). */
const BUILD_INPUT = /^(?:electron\.vite\.config\.ts|tsconfig[^/]*\.json|package\.json|bun\.lock)$/;
/** Root files that decide which tests vitest runs and with what. */
const TEST_RUNNER = /^(?:vitest[^/]*\.[cm]?ts|package\.json|bun\.lock|bunfig\.toml)$/;

export interface ChangedScope {
	/** Every changed file a check looks at (source and root configuration). */
	files: string[];
	/** A root build input changed: build even when no e2e spec matched. */
	build: boolean;
	/** A test-runner input changed: run every vitest test, not only the related ones. */
	allTests: boolean;
}

export function changedScope(paths: readonly string[]): ChangedScope {
	const files = [...new Set(paths)].filter(file => SOURCE.test(file) || ROOT_CONFIG.test(file)).sort();
	return {
		files,
		build: files.some(file => BUILD_INPUT.test(file)),
		allTests: files.some(file => TEST_RUNNER.test(file)),
	};
}
