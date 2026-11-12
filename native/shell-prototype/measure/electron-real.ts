// bun measure/electron-real.ts: the released Electron app (the installed v0.127.0 bytes, run in place, never changed) on
// a fresh test profile and a fake home (no sessions, no omp login), 3 runs: memory of its Electron processes 20 s after
// start, and of its browser process alone (Chromium's browser plus OMPdesk's Node main), against the baseline shell.
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const proto = resolve(import.meta.dir, "..");
const out = join(proto, "results", "measure");
const exe = join(process.env.LOCALAPPDATA ?? "", "Programs", "OMPdesk", "OMPdesk.exe");
const backup = join(out, "classes-omp.reg");
await Bun.$`reg export ${"HKCU\\Software\\Classes\\omp"} ${backup} /y`.quiet().nothrow();
const rows = [];
for (let run = 1; run <= 3; run++) {
	const ud = join(out, `real-userData-${run}`);
	const home = join(out, `real-home-${run}`);
	rmSync(ud, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });
	const child = Bun.spawn([exe, `--user-data-dir=${ud}`], {
		env: { ...process.env, USERPROFILE: home, HOME: home },
		stdout: "ignore",
		stderr: "ignore",
	});
	await Bun.sleep(25_000);
	const mem = (name: string) =>
		Bun.$`powershell -NoProfile -File ${join(import.meta.dir, "mem.ps1")} -RootPid ${child.pid} -Name ${name}`.json();
	const electron = await mem("OMPdesk");
	const all = await mem("");
	const browser = await Bun.$`powershell -NoProfile -Command ${`$p = Get-Process -Id ${child.pid}; [pscustomobject]@{ privateBytesMB = [math]::Round($p.PrivateMemorySize64/1MB,1); workingSetMB = [math]::Round($p.WorkingSet64/1MB,1) } | ConvertTo-Json -Compress`}`.json();
	const row = { run, electron, all, browserProcess: browser };
	console.log(JSON.stringify(row));
	rows.push(row);
	await Bun.$`taskkill /T /F /PID ${child.pid}`.quiet().nothrow();
	await child.exited;
	await Bun.sleep(3000);
}
await Bun.$`reg import ${backup}`.quiet().nothrow();
await Bun.write(join(out, "electron-real.json"), JSON.stringify(rows, null, 2));
