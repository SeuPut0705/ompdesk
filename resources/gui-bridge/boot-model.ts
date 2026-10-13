/**
 * Prints a `provider/model` selector from the user's omp catalog, for booting
 * omp when no model has credentials. Run with bun:
 *
 *   OMP_PACKAGE_ROOT=<…/@oh-my-pi/pi-coding-agent> bun boot-model.ts
 *
 * Stock `--mode rpc-ui` exits ("No default model selected" / "No models
 * available") when nothing is authenticated, and `omp models` lists
 * authenticated models only, so the pick comes from the catalog's per-provider
 * defaults in whichever omp is installed.
 */
import * as path from "node:path";

const root = process.env.OMP_PACKAGE_ROOT;
if (!root) throw new Error("OMP_PACKAGE_ROOT is not set");

// Runtime-selected: the catalog lives in whichever omp install the GUI resolved.
const catalog: unknown = await import(
	Bun.resolveSync("@oh-my-pi/pi-catalog/provider-models", path.join(root, "package.json"))
);
const defaults =
	typeof catalog === "object" && catalog !== null && "DEFAULT_MODEL_PER_PROVIDER" in catalog
		? catalog.DEFAULT_MODEL_PER_PROVIDER
		: null;
if (typeof defaults !== "object" || defaults === null)
	throw new Error("omp's catalog has no DEFAULT_MODEL_PER_PROVIDER");
const DEFAULT_MODEL_PER_PROVIDER = Object.fromEntries(
	Object.entries(defaults).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

// The providers onboarding most often connects first; otherwise any catalog entry.
const preferred = ["anthropic", "openai", "google"].find(provider => DEFAULT_MODEL_PER_PROVIDER[provider]);
const [provider, model] = preferred
	? [preferred, DEFAULT_MODEL_PER_PROVIDER[preferred]]
	: (Object.entries(DEFAULT_MODEL_PER_PROVIDER)[0] ?? []);
if (!provider || !model) throw new Error("omp's catalog has no provider defaults");
console.log(`${provider}/${model}`);
