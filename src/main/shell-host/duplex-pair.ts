/** Two ends of one in-memory connection for tests: what one writes the other reads. */
import { Duplex, PassThrough } from "node:stream";

function end(readable: PassThrough, writable: PassThrough): Duplex {
	const duplex = new Duplex({
		read() {},
		write(chunk, _encoding, callback) {
			writable.write(chunk, callback);
		},
		final(callback) {
			writable.end(callback);
		},
	});
	readable.on("data", chunk => duplex.push(chunk));
	readable.on("end", () => duplex.push(null));
	return duplex;
}

export function duplexPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	return [end(bToA, aToB), end(aToB, bToA)];
}
