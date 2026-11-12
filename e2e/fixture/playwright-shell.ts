/**
 * What a spec's `import … from "playwright"` resolves to under Playwright's runner (`playwright.config.ts` ›
 * `tsconfig`, `e2e/fixture/shell.tsconfig.json`): the real package with `_electron` replaced by the shell's
 * launcher, so `electron.launch({ args, env })` starts `ompdesk-shell` and hands back the object
 * `shell-launch.ts` describes. Types still come from the real package (the repo's `tsc` never sees this mapping).
 */
import { launchShell } from "./shell-launch";

export * from "playwright-core";

export const _electron = { launch: launchShell };
