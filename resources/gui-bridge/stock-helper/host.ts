/** Stock operations without an AgentSession. Imported modules come from the user's omp.
 * No model calls or agent startup; stdin EOF ends the worker even after an app crash.
 */
import { createInterface } from "node:readline";
import { createDispatcher, type HelperMethods } from "./dispatch";
import { methods as models } from "./models";
import { methods as search } from "./search";
import { methods as sessions } from "./sessions";
import { disposeTerminals, methods as terminals } from "./terminals";

const methods: HelperMethods = {
	...sessions,
	...models,
	...search,
	...terminals,
};
const input = createInterface({ input: process.stdin });
process.on("exit", disposeTerminals);
input.on("close", () => {
	disposeTerminals();
	process.exit(0);
});
input.on(
	"line",
	createDispatcher(
		methods,
		line => process.stdout.write(`${line}\n`),
		method => Object.hasOwn(terminals, method),
	),
);
