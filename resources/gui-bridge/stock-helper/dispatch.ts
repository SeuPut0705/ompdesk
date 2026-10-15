/** Request routing for the stock helper worker (`host.ts`), kept apart so it runs under test without a process.
 *
 * Lines are JSON: `{id, method, params}` runs a method, `{cancel: id}` withdraws a request its caller already
 * gave up on (a timeout). Stock operations share one serial queue, because a session move or delete must not
 * interleave with a scan; a withdrawn request that has not started is skipped, so a mutation never runs after
 * its caller was told it failed. `concurrent` methods (terminals) bypass that queue: a keystroke must not wait
 * behind a session scan, and one slow stock request must not stall them or end the worker.
 */
export type HelperMethods = Record<string, (params: unknown) => unknown | Promise<unknown>>;

export function createDispatcher(
	methods: HelperMethods,
	write: (line: string) => void,
	concurrent: (method: string) => boolean,
): (line: string) => void {
	const withdrawn = new Set<number>();
	let queue: Promise<void> = Promise.resolve();

	const run = async (id: number, method: string, params: unknown): Promise<void> => {
		if (withdrawn.delete(id)) return;
		try {
			const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
			if (!handler) throw new Error("Unknown stock helper method");
			const result = await handler(params);
			write(JSON.stringify({ id, result }));
		} catch (error) {
			write(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
		}
	};

	return line => {
		let id: unknown;
		try {
			const request: unknown = JSON.parse(line);
			if (typeof request !== "object" || request === null) throw new Error("Invalid stock helper request");
			if ("cancel" in request) {
				if (Number.isSafeInteger(request.cancel)) withdrawn.add(request.cancel as number);
				return;
			}
			if (!("id" in request) || !("method" in request)) throw new Error("Invalid stock helper request");
			id = request.id;
			if (!Number.isSafeInteger(id) || typeof request.method !== "string")
				throw new Error("Invalid stock helper request");
			const params = "params" in request ? request.params : undefined;
			const method = request.method;
			if (concurrent(method)) void run(id as number, method, params);
			else queue = queue.then(() => run(id as number, method, params));
		} catch (error) {
			write(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
		}
	};
}
