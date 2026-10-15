/** Request routing for a stock helper worker (`host.ts`), kept apart so it runs under test without a process.
 *
 * Lines are JSON: `{id, method, params}` runs a method, `{cancel: id}` withdraws a request its caller already
 * gave up on (a timeout). The stock worker runs its requests on one serial queue, because a session move or
 * delete must not interleave with a scan; a withdrawn request that has not started is skipped, so a mutation
 * never runs after its caller was told it failed, and answered `{id, error: "withdrawn"}` in its turn, so main
 * can tell a lane that moves from a hung one. The terminals worker is `concurrent`: a keystroke never waits
 * behind another terminal request, and a cancel there has nothing queued to withdraw.
 */
export type HelperMethods = Record<string, (params: unknown) => unknown | Promise<unknown>>;

export function createDispatcher(
	methods: HelperMethods,
	write: (line: string) => void,
	concurrent: boolean,
): (line: string) => void {
	// Ids waiting on the serial queue; a cancel only marks one of these, so nothing outlives its turn.
	const queued = new Set<number>();
	const withdrawn = new Set<number>();
	let queue: Promise<void> = Promise.resolve();

	const run = async (id: number, method: string, params: unknown): Promise<void> => {
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
				if (Number.isSafeInteger(request.cancel) && queued.has(request.cancel as number))
					withdrawn.add(request.cancel as number);
				return;
			}
			if (!("id" in request) || !("method" in request)) throw new Error("Invalid stock helper request");
			id = request.id;
			if (!Number.isSafeInteger(id) || typeof request.method !== "string")
				throw new Error("Invalid stock helper request");
			const params = "params" in request ? request.params : undefined;
			const method = request.method;
			const requestId = id as number;
			if (concurrent) {
				void run(requestId, method, params);
				return;
			}
			queued.add(requestId);
			queue = queue.then(() => {
				queued.delete(requestId);
				if (!withdrawn.delete(requestId)) return run(requestId, method, params);
				write(JSON.stringify({ id: requestId, error: "withdrawn" }));
			});
		} catch (error) {
			write(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
		}
	};
}
