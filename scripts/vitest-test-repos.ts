/**
 * Vitest globalSetup of the node project: one folder per run for the repository each test process builds once
 * (`src/main/local/git/test-repos.ts`), handed to the test processes through the environment and deleted when the
 * run ends. A test process's own exit handler never runs: the pool kills it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export const TEST_REPO_ROOT_ENV = "OMP_TEST_REPO_ROOT";

export default function setup(): () => void {
	const root = mkdtempSync(path.join(tmpdir(), "omp-test-repos-"));
	process.env[TEST_REPO_ROOT_ENV] = root;
	return () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
