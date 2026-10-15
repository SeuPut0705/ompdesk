import { join } from "node:path";

/** The pi-natives grep surface the Files panel's content search uses (gitignore-aware, the agent's own engine). */
interface StockGrep {
	grep(options: {
		pattern: string;
		path: string;
		glob?: string;
		ignoreCase?: boolean;
		hidden?: boolean;
		gitignore?: boolean;
		maxCount?: number;
		maxColumns?: number;
		maxCountPerFile?: number;
		timeoutMs?: number;
	}): Promise<{
		matches: { path: string; lineNumber: number; line: string; column?: number }[];
		totalMatches: number;
		filesWithMatches: number;
		limitReached?: boolean;
	}>;
}

let natives: Promise<StockGrep> | null = null;
function stockGrep(): Promise<StockGrep> {
	natives ??= (async () => {
		const root = process.env.OMP_PACKAGE_ROOT;
		if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
		const stock = await import(Bun.resolveSync("@oh-my-pi/pi-natives", join(root, "package.json")));
		if (typeof stock.grep !== "function") throw new Error("Installed omp has no native grep");
		return stock as StockGrep;
	})();
	return natives;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	/** Main validated `root`, `pattern` (already a regex) and the caps. */
	"search.text": async params => {
		const { root, pattern, ignoreCase, glob, maxCount } = params as {
			root: string;
			pattern: string;
			ignoreCase: boolean;
			glob?: string;
			maxCount: number;
		};
		const result = await (await stockGrep()).grep({
			pattern,
			path: root,
			glob,
			ignoreCase,
			hidden: false,
			gitignore: true,
			maxCount,
			maxColumns: 240,
			maxCountPerFile: 50,
			timeoutMs: 15_000,
		});
		return {
			matches: result.matches.map(match => ({
				path: match.path.split("\\").join("/"),
				line: match.lineNumber,
				text: match.line,
				...(match.column ? { column: match.column } : {}),
			})),
			totalMatches: result.totalMatches,
			files: result.filesWithMatches,
			limited: result.limitReached === true,
		};
	},
};
