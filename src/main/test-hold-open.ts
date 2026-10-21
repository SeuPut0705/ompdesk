import { spawn } from "node:child_process";

/**
 * A second process that has `file` open for reading for `ms`: what a virus scan, a backup or a poll is to a save.
 * Windows refuses a rename over a file another process holds open (EPERM). Resolves once the file is open;
 * `closed` resolves once the reader has let go.
 */
export function holdOpen(file: string, ms: number): Promise<{ closed: Promise<void> }> {
	const script = `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"r");console.log("open");setTimeout(()=>{fs.closeSync(fd);process.exit(0)},${ms})`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const opened = Promise.withResolvers<{ closed: Promise<void> }>();
	child.once("error", opened.reject);
	child.stdout.once("data", () => opened.resolve({ closed: exited.promise }));
	return opened.promise;
}
