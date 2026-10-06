/**
 * HTTP client for the private, bundled omp stats dashboard API.
 * Polls GET endpoints; discovers availability via x-omp-stats-dashboard header.
 */

const DEFAULT_PORT = 0;
const REQUEST_TIMEOUT_MS = 5000;

export const VALID_PATHS: Record<string, true> = {
	"/api/stats/overview": true,
	"/api/stats/model-dashboard": true,
	"/api/stats/costs": true,
	"/api/stats/frustration": true,
	"/api/stats/tools": true,
	"/api/stats/providers": true,
	"/api/stats/provider-windows": true,
	"/api/stats/recent": true,
	"/api/stats/requests": true,
	"/api/stats/errors": true,
	"/api/stats/models": true,
	"/api/stats/folders": true,
	"/api/stats/timeseries": true,
	"/api/stats/gain": true,
	"/api/stats": true,
	"/api/status": true,
	"/api/sync": true,
};

/** Endpoints that mutate state — the stats server answers these with 405 on GET. */
export const POST_PATHS: Record<string, true> = {
	"/api/sync": true,
};

export class StatsClient {
	#port: number;
	#available = false;

	constructor(port = DEFAULT_PORT) {
		this.#port = port;
	}

	get port(): number {
		return this.#port;
	}

	set port(value: number) {
		this.#port = value;
		this.#available = false;
	}

	get available(): boolean {
		return this.#available;
	}

	/**
	 * Probe the stats server by hitting /api/stats/models
	 * and checking for the x-omp-stats-dashboard header.
	 */
	async probe(): Promise<boolean> {
		if (this.#port === 0) return false;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const resp = await fetch(`http://127.0.0.1:${this.#port}/api/stats/models`, {
				signal: controller.signal,
			});
			this.#available = resp.headers.has("x-omp-stats-dashboard");
			return this.#available;
		} catch {
			this.#available = false;
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Fetch a stats endpoint. Path must be one of the known endpoints.
	 * /api/request/:id is also allowed (dynamic path prefix).
	 */
	async fetch(path: string, params?: Record<string, string>): Promise<unknown> {
		if (this.#port === 0) throw new Error("The bundled stats server is not ready. Please retry shortly.");
		// Validate path: allow known paths or /api/request/:id pattern
		const isRequestPath = /^\/api\/request\/\d+$/.test(path);
		if (!isRequestPath && !VALID_PATHS[path]) {
			throw new Error(`Invalid stats path: ${path}`);
		}

		const url = new URL(`http://127.0.0.1:${this.#port}${path}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const resp = await fetch(url.toString(), {
				method: POST_PATHS[path] ? "POST" : "GET",
				signal: controller.signal,
			});
			if (!resp.ok) {
				throw new Error(`Stats API error: ${resp.status} ${resp.statusText}`);
			}
			return await resp.json();
		} finally {
			clearTimeout(timer);
		}
	}
}
