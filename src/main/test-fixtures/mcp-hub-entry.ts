/**
 * The MCP hub (resources/gui-bridge/mcp-hub.ts) as tests start it: run by Bun, the fake REA of ./rea-child.mjs (or
 * `REA_TEST_COMMAND`, a REA that cannot start), the secret from `HUB_TEST_SECRET`. Prints the hub's listening line
 * and stops on stdin EOF, as the real entry does.
 */
import { fileURLToPath } from "node:url";
import { startHub } from "../../../resources/gui-bridge/mcp-hub";

const hub = startHub({
	secret: process.env.HUB_TEST_SECRET ?? "",
	port: Number(process.env.OMP_GUI_MCP_HUB_PORT) || 0,
	reaCacheDir: process.env.OMP_GUI_REA_CACHE || undefined,
	memoryStateFile: process.env.OMP_GUI_MEMORY || undefined,
	rea: {
		command: process.env.REA_TEST_COMMAND || process.execPath,
		args: [fileURLToPath(new URL("./rea-child.mjs", import.meta.url))],
	},
});
process.stdout.write(`mcp-hub listening http://127.0.0.1:${hub.port}\n`);
process.stdin.on("end", () => void hub.stop().finally(() => process.exit(0)));
process.stdin.resume();
