#!/usr/bin/env bun
/// <reference types="bun" />
import * as fs from "node:fs";
import { runModelSetup } from "./fixture/model-setup";
import { runPrint } from "./fixture/print";
import { runRpcUi } from "./fixture/rpc-ui";
import { runStats } from "./fixture/stats";
import { runUpdateCheck } from "./fixture/update-check";
import { FIXTURE_OMP_VERSION } from "./fixture/version";
import { runWorktree } from "./fixture/worktree";

// A local stand-in for the system omp the GUI drives: stock `--mode rpc-ui` on
// stdin/stdout, plus the gui-bridge extension's socket (loaded with `-e`,
// address in `OMP_GUI_BRIDGE`) answering the bridge methods the e2e suites
// reach. No provider credentials, external network, or user session files.
// This file only dispatches on the invocation; each mode lives in `e2e/fixture/`.
if (process.env.OMP_GUI_TEST_BOOT_LOG && process.argv.includes("rpc-ui")) {
	fs.appendFileSync(process.env.OMP_GUI_TEST_BOOT_LOG, `${FIXTURE_OMP_VERSION}\n`);
}
if (process.argv.includes("--version")) {
	console.log(`omp/${FIXTURE_OMP_VERSION}`);
	process.exit(0);
}
if (process.argv[2] === "stats") await runStats();
else if (process.env.OMP_GUI_TEST_MODEL_SETUP === "1" && process.argv.includes("rpc")) runModelSetup();
else if (process.argv[2] === "update" && process.argv.includes("--check")) runUpdateCheck();
else if (process.argv[2] === "worktree" && process.argv.includes("--json")) runWorktree();
else if (process.argv[2] === "-p") await runPrint();
else if (!process.argv.includes("--mode")) {
	// Other CLI calls have no local stand-in.
	console.error(`fixture: unsupported invocation: ${process.argv.slice(2).join(" ")}`);
	process.exit(1);
} else runRpcUi();
