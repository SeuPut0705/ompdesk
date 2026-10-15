/**
 * A fake OpenSSH client for main/ssh tests and e2e (POSIX only): `ssh`,
 * `ssh-add` and `ssh-keygen` scripts in one folder (point `OMP_GUI_SSH` at
 * `<dir>/ssh`). Like real ssh it reads the known_hosts the `-F` config names,
 * asks an unknown host key and a password through `$SSH_ASKPASS`, serves `-L`
 * forwards to 127.0.0.1 (the "server" is this machine), and lists the ports
 * in `<dir>/ports` for a remote command. Test knobs, all files in `<dir>`:
 * `password` (required password), `drop` (exists → a running forward exits as
 * a dropped connection), `changed` (exists → the host key changed), `calls`
 * (every argv, one JSON line each).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SSH = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dir = __DIR__;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify(args) + "\n");
let config = "", port = "22", user = "me", local = null, resolve = false, rest = [];
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "-F") config = args[++i];
	else if (arg === "-p") port = args[++i];
	else if (arg === "-l") user = args[++i];
	else if (arg === "-i" || arg === "-o") i++;
	else if (arg === "-L") local = args[++i];
	else if (arg === "-G") resolve = true;
	else if (arg === "-N") {}
	else if (arg === "--") { rest = args.slice(i + 1); break; }
	else { rest = args.slice(i); break; }
}
const host = rest[0];
const command = rest.slice(1);
if (resolve) {
	process.stdout.write("hostname " + host + "\nport " + port + "\nuser " + user + "\nproxyjump none\n");
	process.exit(0);
}
const knownHosts = /UserKnownHostsFile "([^"]+)"/.exec(fs.readFileSync(config, "utf8"))[1];
const ask = prompt => {
	try {
		return execFileSync(process.env.SSH_ASKPASS, [prompt], { encoding: "utf8" }).replace(/\n$/, "");
	} catch {
		return null;
	}
};
const known = fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, "utf8") : "";
const entry = (port === "22" ? host : "[" + host + "]:" + port) + " ssh-ed25519 ";
if (known.includes(entry) && fs.existsSync(path.join(dir, "changed"))) {
	process.stderr.write("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:changedchangedchanged.\nHost key verification failed.\n");
	process.exit(255);
}
if (!known.includes(entry)) {
	const answer = ask("The authenticity of host '" + host + " (127.0.0.1)' can't be established.\nED25519 key fingerprint is SHA256:fakeFingerprint123.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
	if (answer !== "yes") {
		process.stderr.write("Host key verification failed.\n");
		process.exit(255);
	}
	fs.appendFileSync(knownHosts, entry + "AAAAfake\n");
}
const passwordFile = path.join(dir, "password");
if (fs.existsSync(passwordFile)) {
	const answer = ask(user + "@" + host + "'s password: ");
	if (answer !== fs.readFileSync(passwordFile, "utf8").trim()) {
		process.stderr.write(user + "@" + host + ": Permission denied (publickey,password).\n");
		process.exit(255);
	}
}
if (local) {
	const [bindHost, bindPort, toHost, toPort] = local.split(":");
	const server = net.createServer(client => {
		const upstream = net.connect(Number(toPort), toHost);
		client.pipe(upstream).pipe(client);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
	});
	server.on("error", error => {
		process.stderr.write("bind [" + bindHost + "]:" + bindPort + ": Address already in use\n");
		process.exit(255);
	});
	server.listen(Number(bindPort), bindHost);
	setInterval(() => {
		if (fs.existsSync(path.join(dir, "drop"))) {
			process.stderr.write("Connection to " + host + " closed by remote host.\n");
			process.exit(255);
		}
	}, 100);
} else if (command.length) {
	const list = () => {
		const ports = fs.existsSync(path.join(dir, "ports")) ? fs.readFileSync(path.join(dir, "ports"), "utf8").trim().split(/\s+/).filter(Boolean) : [];
		process.stdout.write(ports.map(p => "LISTEN 0 4096 127.0.0.1:" + p + " 0.0.0.0:*").join("\n") + "\n__ompdesk_ports__\n");
	};
	list();
	setInterval(list, 300);
} else process.exit(0);
`;

const SSH_ADD = String.raw`
process.stdout.write("256 SHA256:agentKeyFingerprint fake@laptop (ED25519)\n");
process.exit(0);
`;

const SSH_KEYGEN = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "-R") process.exit(1);
const name = args[1], file = args[3];
const kept = (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").split("\n").filter(line => line && !line.startsWith(name + " "));
fs.writeFileSync(file, kept.map(line => line + "\n").join(""));
`;

/** Write the fake tools into `dir`; returns the `ssh` path for `OMP_GUI_SSH`. */
export async function writeFakeSsh(dir: string, node: string = process.execPath): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	for (const [name, source] of [
		["ssh", SSH.replace("__DIR__", JSON.stringify(dir))],
		["ssh-add", SSH_ADD],
		["ssh-keygen", SSH_KEYGEN],
	] as const) {
		await fs.writeFile(path.join(dir, name), `#!${node}\n${source}`, { mode: 0o755 });
	}
	return path.join(dir, "ssh");
}
