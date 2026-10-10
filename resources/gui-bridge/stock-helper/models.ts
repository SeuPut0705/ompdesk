/** Main-side worker: stock models.yml schemas/catalog need Bun, not Electron's Node runtime. */
import * as path from "node:path";

interface Schema {
	assert(value: unknown): unknown;
	get(...keys: Array<string | number>): Schema;
	ir: unknown;
}
async function stockSchema(): Promise<Schema> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	// Runtime-selected: the schema belongs to the user's resolved omp installation.
	const module = await import(Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/models-config-schema", path.join(root, "package.json")));
	const schema = module.ModelsConfigSchema as Schema;
	if (typeof schema?.assert !== "function" || typeof schema.get !== "function") {
		throw new Error("Installed omp has no ModelsConfigSchema");
	}
	return schema;
}
function literals(ir: unknown): string[] {
	if (!ir || typeof ir !== "object") return [];
	const node = ir as Record<string, unknown>;
	if (node.k === "lit" && typeof node.v === "string") return [node.v];
	if (node.k === "union" && Array.isArray(node.members)) return node.members.flatMap(literals);
	if (node.k === "sub" && node.schema && typeof node.schema === "object") {
		return literals((node.schema as Record<string, unknown>).ir);
	}
	return [];
}
export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"catalog.roster": async () => {
	const schema = await stockSchema();
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	const resolve = (specifier: string) => Bun.resolveSync(specifier, path.join(root, "package.json"));
	// Runtime-selected: catalog modules belong to the resolved omp installation.
	const [providers, auth] = await Promise.all([
		import(resolve("@oh-my-pi/pi-catalog/compat/providers")),
		import(resolve("@oh-my-pi/pi-catalog/compat/auth")),
	]);
	if (typeof providers.providerEntries !== "function" || typeof auth.authProviders !== "function") {
		throw new Error("Installed omp cannot determine built-in providers");
	}
	const provider = schema.get("providers", "_gui");
	const options = (...keys: Array<string | number>) => literals(provider.get(...keys).ir);
	return {
		builtinProviders: [...new Set([
			...Object.keys(providers.providerEntries()),
			...auth.authProviders().map((entry: { id: string }) => entry.id),
		])],
		apis: options("api"),
		auth: options("auth"),
		discovery: options("discovery", "type"),
		thinkingModes: options("models", 0, "thinking", "mode"),
		efforts: options("models", 0, "thinking", "efforts", 0),
	};
	},
	"models.validate": async params => {
	const schema = await stockSchema();
	if (!params || typeof params !== "object" || !("config" in params)) throw new Error("config is required");
	try {
		return { config: schema.assert(params.config) };
	} catch {
		// Schema errors may include credential values: never send or log those values.
		return { error: "models.yml does not satisfy stock omp ModelsConfigSchema" };
	}
	},
};
