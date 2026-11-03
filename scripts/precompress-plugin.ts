/**
 * Renderer build step: writes `<file>.br` (brotli at quality 11) beside every file a paired phone's page loads from
 * out/renderer (`assets/`, `web.html`, `sw.js`) that is over 1 KB and compressible. The web server
 * (src/main/web/server.ts) sends it to a browser that accepts br instead of compressing on the first request at
 * quality 9: 11 is ~40× slower, fine once per build and too slow per request. Measured on 3 Nov 2026: the phone's
 * first-screen JavaScript went 666,236 → 615,573 bytes on the wire (50,663 bytes less, ~45 ms at 9 Mbit/s), and the
 * first request of each file no longer compresses on this computer (the app's main chunk took 31 ms at 9). It adds
 * about 3 s to a build and 3 MB to out/. This file is a `BUILD_SCRIPTS` input of scripts/build-cache.ts.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress);

/** The web server's compressible types (server.ts `COMPRESSIBLE`) by extension, and only files it serves. */
const SERVED_COMPRESSIBLE = /^(assets\/.+\.(js|mjs|css|json|svg|wasm|txt|html)|web\.html|sw\.js)$/;
/** The server leaves files this small uncompressed. */
const MIN_BYTES = 1025;

export function precompressPlugin(): Plugin {
	return {
		name: "omp-precompress",
		apply: "build",
		enforce: "post",
		async writeBundle(options, bundle) {
			const dir = options.dir;
			if (!dir) throw new Error("precompress: the renderer build has no output folder");
			await Promise.all(
				Object.values(bundle).map(async entry => {
					if (!SERVED_COMPRESSIBLE.test(entry.fileName)) return;
					const bytes = Buffer.from(entry.type === "chunk" ? entry.code : entry.source);
					if (bytes.byteLength < MIN_BYTES) return;
					const packed = await brotli(bytes, {
						params: {
							[constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
							[constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
						},
					});
					await writeFile(path.join(dir, `${entry.fileName}.br`), packed);
				}),
			);
		},
	};
}
