// electron seed-profile.cjs --user-data-dir=<dir>: a test profile written the way OMPdesk's Electron writes it
// (same Electron as v0.127.0): a stand-in update token through safeStorage (DPAPI on Windows, the keychain on
// macOS) into update-token.bin, and file:// Local Storage keys (a composer draft, Korean text, a large value).
const { app, BrowserWindow, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setName("ompdesk");
app.whenReady().then(async () => {
	const dir = app.getPath("userData");
	const token = process.env.STAND_IN_TOKEN || "ghp_STANDIN_not_a_real_token_0123456789";
	fs.writeFileSync(path.join(dir, "update-token.bin"), safeStorage.encryptString(token), { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "deleted-sessions.json"), JSON.stringify({ version: 1, entries: [] }));
	const page = path.join(dir, "seed.html");
	fs.writeFileSync(page, "<!doctype html><title>seed</title>");
	const win = new BrowserWindow({ show: false });
	await win.loadFile(page);
	await win.webContents.executeJavaScript(`
		localStorage.setItem("ompdesk.seed.draft", "a draft typed in Electron");
		localStorage.setItem("ompdesk.seed.korean", "한국어 초안 ✓");
		localStorage.setItem("ompdesk.seed.large", "x".repeat(200000));
		localStorage.length`);
	win.destroy();
	fs.unlinkSync(page);
	const blob = fs.readFileSync(path.join(dir, "update-token.bin"));
	console.log(JSON.stringify({ userData: dir, prefix: blob.subarray(0, 3).toString("latin1"), bytes: blob.length }));
	app.quit();
});
