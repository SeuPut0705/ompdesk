/**
 * Session modes the GUI drives over the bridge: plan mode and plan approval,
 * vibe, the goal operations stock's `goal` command lacks, loop mode, `/btw`,
 * `/tan`, `/omfg` and the agent pause gate. One file per mode under `modes/`.
 */
import { methods as actions } from "./modes/actions";
import { methods as btw } from "./modes/btw";
import { methods as goal } from "./modes/goal";
import { methods as loop } from "./modes/loop";
import { methods as plan } from "./modes/plan";
import { methods as vibe } from "./modes/vibe";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = { ...plan, ...vibe, ...goal, ...loop, ...btw, ...actions };
