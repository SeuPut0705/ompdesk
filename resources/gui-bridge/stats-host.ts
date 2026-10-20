/**
 * Hosts omp's stats dashboard API for the GUI without `omp stats`, which
 * always opens a browser tab (it has no `--no-open`). Run with bun:
 *
 *   OMP_PACKAGE_ROOT=<…/@oh-my-pi/pi-coding-agent> bun stats-host.ts <host> <port>
 *
 * Everything is imported from the user's omp install, so the dashboard is
 * whatever their omp version ships. Prints the same `Dashboard available at:`
 * line `omp stats` prints; the GUI parses the port from it.
 *
 * Stock omp-stats has no paginated request list, which the Requests route
 * needs, and its server takes no extra routes. So the stock server listens on
 * an internal loopback port and a front server answers `/api/stats/requests`
 * from the stock stats database, passing every other request through.
 *
 * Stock ingests sessions into that database only while something runs its
 * live sync (`statsLive().start()`), which its server starts when a dashboard
 * page subscribes to `/api/events`. `omp stats` always opens such a page; the
 * GUI reads the API and never subscribes, so this host starts the same live
 * sync itself: a full sync now and every 5 minutes, and the transcripts a
 * session writes shortly after it writes them.
 */
import * as path from "node:path";

const root = process.env.OMP_PACKAGE_ROOT;
if (!root) throw new Error("OMP_PACKAGE_ROOT is not set");
const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "0");

/** Resolve a module the way code inside the omp package would. */
const fromOmp = (specifier: string) => Bun.resolveSync(specifier, path.join(root, "package.json"));

// Runtime-selected: the modules live in whichever omp install the GUI resolved.
const stats = await import(fromOmp("@oh-my-pi/omp-stats"));
const statsDb = await import(fromOmp("@oh-my-pi/omp-stats/db"));
const { getTimeRangeConfig } = await import(fromOmp("@oh-my-pi/omp-stats/aggregator"));
const { statsLive } = await import(fromOmp("@oh-my-pi/omp-stats/live"));
const { openStandaloneJudge } = await import(fromOmp("@oh-my-pi/pi-coding-agent/judgment/standalone"));
const cwd = process.cwd();
const upstream = await stats.startServer(0, "127.0.0.1", {
	judge: async () => (await openStandaloneJudge(cwd, "stats_frustration")).judge,
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
statsLive().start();

const RANGES = ["1h", "24h", "7d", "30d", "90d", "all"];

interface PageWindow {
	cutoff: number | null;
	until: number;
	maxId?: number;
	after?: { timestamp: number; id: number };
}

/** Cursor = base64url JSON `[lastTimestamp, lastId, cutoff, until, range, maxId]`, pinned to one range. */
function parseCursor(cursor: string, range: string): PageWindow {
	const invalid = new RangeError("Invalid request cursor");
	if (cursor.length > 512) throw invalid;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw invalid;
	}
	if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[4] !== range) throw invalid;
	const [timestamp, id, cutoff, until, , maxId] = parsed;
	if (
		!Number.isSafeInteger(timestamp) ||
		!Number.isSafeInteger(id) ||
		id <= 0 ||
		(cutoff !== null && !Number.isSafeInteger(cutoff)) ||
		!Number.isSafeInteger(until) ||
		!Number.isSafeInteger(maxId) ||
		maxId < id ||
		timestamp > until ||
		(cutoff !== null && cutoff > until)
	)
		throw invalid;
	return { cutoff, until, maxId, after: { timestamp, id } };
}

/** Stable keyset paging over stock's `messages` table, newest first, ties broken by id. */
async function requestPage(url: URL): Promise<Response> {
	const range = url.searchParams.get("range") ?? "24h";
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam === null ? 50 : Number(limitParam);
	const cursor = url.searchParams.get("cursor");
	if (!Number.isInteger(limit) || limit < 1 || limit > 200)
		return Response.json({ error: "limit must be an integer from 1 to 200" }, { status: 400 });
	if (!RANGES.includes(range)) return Response.json({ error: "Invalid request range" }, { status: 400 });
	let window: PageWindow;
	try {
		window = cursor ? parseCursor(cursor, range) : { cutoff: getTimeRangeConfig(range).cutoff, until: Date.now() };
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 400 });
	}
	const db = await statsDb.initDb();
	const maxId = window.maxId ?? db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages").get().id;
	const conditions = ["timestamp <= ?", "id <= ?"];
	const values: number[] = [window.until, maxId];
	if (window.cutoff !== null) {
		conditions.push("timestamp >= ?");
		values.push(window.cutoff);
	}
	const total = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${conditions.join(" AND ")}`).get(...values)
		.count as number;
	if (window.after) {
		conditions.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
		values.push(window.after.timestamp, window.after.timestamp, window.after.id);
	}
	const ids = db
		.prepare(`SELECT id FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC, id DESC LIMIT ?`)
		.all(...values, limit + 1)
		.map((row: { id: number }) => row.id);
	// Stock keeps its row→MessageStats mapping private; getMessageById applies it.
	const rows = ids.slice(0, limit).map((id: number) => statsDb.getMessageById(id));
	const last = rows.at(-1);
	const nextCursor =
		ids.length > limit && last
			? Buffer.from(JSON.stringify([last.timestamp, last.id, window.cutoff, window.until, range, maxId])).toString(
					"base64url",
				)
			: null;
	return Response.json({ rows, total, nextCursor, snapshotAt: window.until });
}

const server = Bun.serve({
	port,
	hostname: host,
	idleTimeout: 0, // the SSE event stream stays open
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/api/stats/requests" && req.method === "GET") return requestPage(url);
		return fetch(`${upstreamOrigin}${url.pathname}${url.search}`, {
			method: req.method,
			headers: req.headers,
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			redirect: "manual",
		});
	},
});
console.log(`Dashboard available at: ${stats.formatStatsDashboardUrl(server.hostname, server.port)}`);

const shutdown = () => {
	server.stop(true);
	stats.closeDb();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The app holds our stdin pipe open for its whole life. When it goes away
// without a clean quit (crash, force-kill, an app swap), the pipe closes and
// this server must not outlive it as an orphan.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
