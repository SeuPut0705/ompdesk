import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { reaExtensionArgs } from "../shared/builtin-mcp";
import { SidecarManager } from "./sidecar";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

describe("built-in MCP sidecar argv", () => {
	it.each([true, false])("adds a directory root only when available=%s", async available => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-rea-spawn-"));
		const record = path.join(dir, "args.json");
		const bin = await writeFakeOmp(
			dir,
			`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		const builtinRoot = path.join(dir, "omp-builtin");
		const sc = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin, version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: dir,
			bridgeDir: dir,
			builtinMcp: async () => ({ args: reaExtensionArgs(builtinRoot, { enabled: true, available }) }),
		});
		try {
			const ready = Promise.withResolvers<void>();
			sc.on("status", ({ status }) => {
				if (status === "ready") ready.resolve();
			});
			sc.start();
			await ready.promise;
			expect(JSON.parse(await fs.readFile(record, "utf8"))).toEqual([
				"--mode",
				"rpc-ui",
				"-e",
				path.join(dir, "index.ts"),
				...(available ? ["-e", builtinRoot] : []),
			]);
		} finally {
			sc.dispose();
			await fs.rm(dir, RM_TEMP);
		}
	});
});
