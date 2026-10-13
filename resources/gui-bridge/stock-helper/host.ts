/** Stock operations without an AgentSession. Imported modules come from the user's omp.
 * No model calls or agent startup; stdin EOF ends the worker even after an app crash.
 */
import { createInterface } from "node:readline";
import { methods as models } from "./models";
import { methods as sessions } from "./sessions";
import { disposeTerminals, methods as terminals } from "./terminals";

const methods: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
	...sessions,
	...models,
	...terminals,
};
const input = createInterface({ input: process.stdin });
process.on("exit", disposeTerminals);
input.on("close", () => {
	disposeTerminals();
	process.exit(0);
});
for await (const line of input) {
	let id: unknown;
	try {
		const request: unknown = JSON.parse(line);
		if (typeof request !== "object" || request === null || !("id" in request) || !("method" in request))
			throw new Error("Invalid stock helper request");
		id = request.id;
		if (!Number.isSafeInteger(id) || typeof request.method !== "string")
			throw new Error("Invalid stock helper request");
		const method = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
		if (!method) throw new Error("Unknown stock helper method");
		const result = await method("params" in request ? request.params : undefined);
		process.stdout.write(`${JSON.stringify({ id, result })}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
	}
}
