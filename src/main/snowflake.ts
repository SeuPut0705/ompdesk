/**
 * Snowflake id generator — vendored from packages/utils/src/snowflake.ts
 * (Snowflake.Source + Snowflake.next). The GUI may not runtime-import
 * @oh-my-pi/* packages, so the algorithm is copied: 16-char lowercase hex,
 * (timestamp - EPOCH) << 22 | seq, time-ordered and collision-resistant
 * within the process. Used to mint opaque tab ids.
 */

const EPOCH = 1420070400000;
const MAX_SEQ = 0x3fffff;

/** Process-local sequence, seeded randomly (same scheme as the source util). */
let seq = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) & MAX_SEQ;

/** Mint the next snowflake id as a 16-char hex string. */
export function nextSnowflake(timestamp = Date.now()): string {
	seq = (seq + 1) & MAX_SEQ;
	return ((BigInt(timestamp - EPOCH) << 22n) | BigInt(seq)).toString(16).padStart(16, "0");
}
