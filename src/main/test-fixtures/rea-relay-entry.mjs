import { fileURLToPath } from "node:url";
import { startRelay } from "../../../resources/omp-builtin/rea/rea-relay.mjs";

// `REA_TEST_COMMAND`: a REA that cannot start (a command that does not exist), as an offline `npx` would be.
startRelay(process.env.REA_TEST_COMMAND || process.execPath, [
	fileURLToPath(new URL("./rea-child.mjs", import.meta.url)),
]);
