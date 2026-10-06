import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Tests assert English UI text; pin the inferred UI language so a Korean or
		// Chinese host locale (navigator.language follows the OS) cannot flip it.
		setupFiles: ["./vitest.setup.ts"],
	},
});
