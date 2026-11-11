/**
 * Vitest globalSetup of the node project: OMPdesk's own native binaries (`bun run build:native`) are staged and this
 * checkout's build before any test runs, so every test that reaches the core process (`src/main/core/process.ts`) or
 * runs the CLI finds them. A fresh staging only hashes the sources; a stale one is built once per run.
 */
import { ensureNative } from "./build-native";

export default function setup(): void {
	ensureNative();
}
