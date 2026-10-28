// Toy code for the job-lease example: one job row, many workers, a lease that can expire under a slow holder.
export interface Db {
	/** One atomic statement: take the job if it is free or its lease expired. Returns the new fencing token, or null. */
	claim(workerId: string, leaseMs: number): Promise<number | null>;
	/** One atomic statement: mark the job done only while the row still carries this token. Returns rows changed. */
	commit(token: number): Promise<number>;
}

export type Outcome = "done" | "lost" | "idle";

export async function runJob(db: Db, workerId: string, leaseMs: number, work: () => Promise<void>): Promise<Outcome> {
	const token = await db.claim(workerId, leaseMs);
	if (token === null) return "idle";

	await work();

	const changed = await db.commit(token);
	if (changed === 0) return "lost";
	return "done";
}
