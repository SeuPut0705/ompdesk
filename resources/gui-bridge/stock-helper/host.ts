/** Stock operations without an AgentSession. Imported modules come from the user's omp.
 * No model calls or agent startup; stdin EOF ends the worker even after an app crash.
 *
 * `host.ts terminals` is the terminals worker (PTYs, all requests concurrent); `host.ts stock` runs every other
 * stock request on one serial lane. Separate processes, so main can end a stock worker whose request hung
 * without taking a single shell with it.
 */
import { createInterface } from "node:readline";
import { createDispatcher, type HelperMethods } from "./dispatch";
import { methods as models } from "./models";
import { methods as search } from "./search";
import { methods as sessions } from "./sessions";
import { disposeTerminals, methods as terminals } from "./terminals";

const terminalWorker = process.argv[2] === "terminals";
const methods: HelperMethods = terminalWorker ? terminals : { ...sessions, ...models, ...search };
const input = createInterface({ input: process.stdin });
if (terminalWorker) process.on("exit", disposeTerminals);
input.on("close", () => {
	if (terminalWorker) disposeTerminals();
	process.exit(0);
});
input.on(
	"line",
	createDispatcher(methods, line => process.stdout.write(`${line}\n`), terminalWorker),
);
