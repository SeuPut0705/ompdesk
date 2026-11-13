/**
 * This computer's admission key for check control's tickets (check-control › Starting, waiting and the answer; design
 * §7 criterion 1). One key per computer, never synced: made once, kept encrypted by the OS keystore (`safeStorage`)
 * in `<userData>/checks-admission-key`, handed to the core's hub when it opens (`checks.open {admission}`) and to
 * GitHub only by `publishAdmissionKey`, on gh's stdin. It never enters a session's environment, an argument list, a
 * log or an answer (design §9.7).
 *
 * The device name in a ticket and in the secret's name (`CHECKS_ADMISSION_KEY_<DEVICE>`) is this computer's remote
 * device id in capitals: stable, distinct per computer and already `[A-Z0-9]`.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GITHUB_REPO } from "../../shared/schedules";
import { writeFileAtomic } from "../atomic-file";
import { execBin, resolveBin } from "../local/git/exec";

/** What the hub mints tickets with. */
export interface AdmissionKey {
	device: string;
	/** 32 bytes in hex. */
	key: string;
}

/** The OS keystore as this module uses it (Electron's `safeStorage`). */
export interface SecretBox {
	available(): boolean;
	encrypt(text: string): Buffer;
	decrypt(data: Buffer): string;
}

/** The repository variable that lists the computers with a key; the gate is off while it is empty. */
export const DEVICES_VARIABLE = "CHECKS_ADMISSION_DEVICES";

/** A ticket's device name: what `ticket.rs` `device_ok` and queue-gate.yml's `device` step accept. */
const DEVICE = /^[A-Z0-9_]{1,40}$/;
const KEY = /^[0-9a-f]{64}$/;

export function admissionDevice(deviceId: string): string | null {
	const device = deviceId.toUpperCase();
	return DEVICE.test(device) ? device : null;
}

export function secretName(device: string): string {
	return `CHECKS_ADMISSION_KEY_${device}`;
}

export function keyFile(userData: string): string {
	return join(userData, "checks-admission-key");
}

/**
 * This computer's key, made on first use. Null when the keystore cannot keep it (then this computer's dispatches
 * carry no ticket) or the device id is not one a secret can be named after.
 */
export async function loadAdmissionKey(
	userData: string,
	deviceId: string,
	box: SecretBox,
): Promise<AdmissionKey | null> {
	const device = admissionDevice(deviceId);
	if (!device || !box.available()) return null;
	const file = keyFile(userData);
	try {
		const key = box.decrypt(await readFile(file));
		if (KEY.test(key)) return { device, key };
	} catch {
		// Missing or not this keystore's: a new key replaces it (an unpublished one is worth nothing elsewhere).
	}
	const key = randomBytes(32).toString("hex");
	await writeFileAtomic(file, box.encrypt(key), { mode: 0o600 });
	return { device, key };
}

/** How `publishAdmissionKey` runs gh: arguments, and what it writes to gh's stdin. */
export type RunGh = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Sets `CHECKS_ADMISSION_KEY_<DEVICE>` in `repo` to this computer's key (on gh's stdin, never an argument) and adds
 * the device to `CHECKS_ADMISSION_DEVICES`, so queue-gate.yml checks this computer's tickets from now on. Answers the
 * devices the variable lists after.
 */
export async function publishAdmissionKey(repo: string, admission: AdmissionKey, gh: RunGh): Promise<string[]> {
	const failed = (what: string, result: { code: number; stderr: string }) =>
		new Error(`${what} failed (gh exited ${result.code}): ${result.stderr.trim()}`);
	const set = await gh(["secret", "set", secretName(admission.device), "--repo", repo], admission.key);
	if (set.code !== 0) throw failed(`gh secret set ${secretName(admission.device)}`, set);
	const read = await gh(["variable", "get", DEVICES_VARIABLE, "--repo", repo]);
	// A variable not set yet is gh's "not found"; any other failure must not drop the devices already listed.
	if (read.code !== 0 && !/not found|404/i.test(read.stderr))
		throw failed(`gh variable get ${DEVICES_VARIABLE}`, read);
	const listed = read.code === 0 ? read.stdout.split(/[\s,]+/).filter(Boolean) : [];
	const devices = listed.includes(admission.device) ? listed : [...listed, admission.device];
	const wrote = await gh(["variable", "set", DEVICES_VARIABLE, "--repo", repo, "--body", devices.join(" ")]);
	if (wrote.code !== 0) throw failed(`gh variable set ${DEVICES_VARIABLE}`, wrote);
	return devices;
}

/**
 * `checks:publish-admission-key` (the app action `checks.publish_admission_key`, which always asks the person):
 * publishes `admission` to `repo` with this computer's gh.
 */
export async function publishWithGh(
	repo: unknown,
	admission: AdmissionKey | null,
): Promise<{ secret: string; devices: string[] }> {
	if (typeof repo !== "string" || !GITHUB_REPO.test(repo)) throw new Error("repo is owner/name");
	if (!admission) throw new Error("this computer has no admission key: its OS keystore is not available");
	const bin = await resolveBin("gh");
	if (!bin) throw new Error("gh is not installed on this computer");
	const gh: RunGh = async (args, stdin) => {
		const ran = await execBin(bin, args, {
			cwd: homedir(),
			...(stdin === undefined ? {} : { input: Buffer.from(stdin) }),
		});
		return { code: ran.code, stdout: ran.stdout.toString(), stderr: ran.stderr };
	};
	const devices = await publishAdmissionKey(repo, admission, gh);
	return { secret: secretName(admission.device), devices };
}
