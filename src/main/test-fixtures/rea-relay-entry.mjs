import { fileURLToPath } from "node:url";
import { startRelay } from "../../../resources/omp-builtin/rea-relay.mjs";

startRelay(process.execPath, [fileURLToPath(new URL("./rea-child.mjs", import.meta.url))]);
