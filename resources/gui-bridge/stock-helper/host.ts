/** Stock operations without an AgentSession. Imported modules come from the user's omp.
 * No model calls or agent startup; stdin EOF ends the worker even after an app crash.
 *
 * `host.ts terminals` is the terminals worker (PTYs, all requests concurrent); `host.ts extensions` runs the
 * `extensions.*` requests (marketplace, plugin and skill updates, the MCP inventory: a plugin upgrade runs
 * `bun install` for minutes) on a serial lane of its own; `host.ts stock` runs every other stock request on
 * one serial lane. Separate processes, so main can end a stock worker whose request hung without taking a
 * single shell or a running upgrade with it. The extensions module is loaded only by its own worker.
 */
import { createInterface } from "node:readline";
import { methods as accounts } from "./accounts";
import { createDispatcher, type HelperMethods } from "./dispatch";
import { UNQUEUED_METHODS as HISTORY_UNQUEUED, methods as history } from "./history";
import { methods as images } from "./images";
import { methods as models } from "./models";
import { methods as search } from "./search";
import { UNQUEUED_METHODS as SESSIONS_UNQUEUED, methods as sessions } from "./sessions";
import { disposeTerminals, methods as terminals } from "./terminals";
import { methods as worktrees } from "./worktrees";

const worker = process.argv[2];
const terminalWorker = worker === "terminals";
const methods: HelperMethods = terminalWorker
	? terminals
	: worker === "extensions"
		? (await import("./extensions")).methods
		: { ...sessions, ...models, ...search, ...accounts, ...images, ...worktrees, ...history };
const input = createInterface({ input: process.stdin });
if (terminalWorker) process.on("exit", disposeTerminals);
input.on("close", () => {
	if (terminalWorker) disposeTerminals();
	process.exit(0);
});
input.on(
	"line",
	createDispatcher(
		methods,
		line => process.stdout.write(`${line}\n`),
		terminalWorker ? true : worker === "extensions" ? false : { ...SESSIONS_UNQUEUED, ...HISTORY_UNQUEUED },
	),
);
