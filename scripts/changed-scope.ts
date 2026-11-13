/**
 * Which changed files `check:changed` checks, and how (scripts/check-changed.ts). Source lives under `src/`, `e2e/`,
 * `resources/` and `scripts/`; the repository's root configuration decides how all of it is typed, linted, built and
 * tested, so a change there is checked too instead of reading as "nothing changed": the typecheck and biome always, the
 * build for a build input, and the whole vitest run for what decides which tests run and how (`vitest related` finds no
 * test through a config file).
 */
import { isBuildInput } from "./build-cache";

const SOURCE = /^(?:src|e2e|resources|scripts)\//;
const ROOT_CONFIG =
	/^(?:[^/]+\.config\.[cm]?ts|vitest[^/]*\.[cm]?ts|tsconfig[^/]*\.json|package\.json|bun\.lock|bunfig\.toml|biome\.jsonc?)$/;
/** Root files that decide which tests vitest runs and with what. */
const TEST_RUNNER = /^(?:vitest[^/]*\.[cm]?ts|package\.json|bun\.lock|bunfig\.toml)$/;

const BIOME_EXT = /\.(?:[cm]?[jt]sx?|json|jsonc|css)$/;
const BIOME_DIRS = /^(?:(?:src|e2e|resources|scripts)\/|[^/]+$)/;

/** The files biome runs on: `check:changed` and the pre-push gate (scripts/pre-push-gate.ts) pick them alike. */
export function biomeFiles(files: readonly string[]): string[] {
	return files.filter(file => BIOME_DIRS.test(file) && BIOME_EXT.test(file));
}

export interface ChangedScope {
	/** Every changed file a check looks at (source and root configuration). */
	files: string[];
	/** A build input changed (`isBuildInput`: app source, resources, root build config): build even when no e2e spec matched. */
	build: boolean;
	/** A test-runner input changed: run every vitest test, not only the related ones. */
	allTests: boolean;
}

export function changedScope(paths: readonly string[]): ChangedScope {
	const files = [...new Set(paths)].filter(file => SOURCE.test(file) || ROOT_CONFIG.test(file)).sort();
	return {
		files,
		build: files.some(isBuildInput),
		allTests: files.some(file => TEST_RUNNER.test(file)),
	};
}
