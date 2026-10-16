/**
 * Prompt origins (A85): the registered bridge module. The pure rules, the
 * `message_end` hook and the `prompt_origin_set` method live in
 * ./prompt-origin-core.ts (no omp imports, so the GUI's vitest and typecheck
 * can load it); this file only types the methods for the bridge.
 */
import { methods as coreMethods } from "./prompt-origin-core";
import type { BridgeMethods } from "./types";

export { install, type PromptOriginHost, promptOrigin } from "./prompt-origin-core";

export const methods: BridgeMethods = coreMethods;
