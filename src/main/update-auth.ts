/**
 * GitHub token for the private release repo. Every user authenticates as
 * themselves — the app never bundles a token. Precedence:
 *   1. GH_TOKEN / GITHUB_TOKEN (launch env, then the login shell's exports);
 *   2. `gh auth token` (the GitHub CLI's login);
 *   3. a token pasted in Settings › Updates, encrypted at rest with safeStorage.
 *
 * On macOS any safeStorage call — `isEncryptionAvailable()` included — opens
 * the "ompdesk Safe Storage" keychain item, and because ad-hoc builds change
 * code identity with every update, macOS asks for the login password again
 * after each one (and blocks the main process while it waits). So the
 * keychain is touched only when a stored token actually exists, or when the
 * user saves one.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app, net, safeStorage } from "electron";
import { codedError } from "../shared/ipc-error-codes";
import type { UpdateAccess, UpdateAuthInfo, UpdateTokenSource } from "../shared/ipc-types";
import { resolveLoginShellEnv, spawnPath } from "./shell-env";
import { classifyRepoAccess, firstUpdateToken, type ResolvedUpdateToken } from "./updater-state";

export const RELEASE_REPO = { owner: "SeuPut0705", repo: "ompdesk" } as const;
export const GITHUB_API_REPO = `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`;

const GH_TIMEOUT_MS = 5_000;

function storedTokenPath(): string {
	return path.join(app.getPath("userData"), "update-token.bin");
}

async function envToken(): Promise<string | undefined> {
	const launch = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (launch) return launch;
	const { env } = await resolveLoginShellEnv();
	return env.GH_TOKEN || env.GITHUB_TOKEN;
}

async function ghToken(): Promise<string | undefined> {
	const pathEnv = await spawnPath();
	const command = process.platform === "win32" ? "gh.exe" : "gh";
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile(
		command,
		["auth", "token", "--hostname", "github.com"],
		{ env: { ...process.env, PATH: pathEnv }, timeout: GH_TIMEOUT_MS, windowsHide: true },
		(error, stdout) => resolve(error ? undefined : stdout),
	);
	return promise;
}

async function storedToken(): Promise<string | undefined> {
	let encrypted: Buffer;
	try {
		encrypted = await fs.readFile(storedTokenPath());
	} catch {
		return undefined;
	}
	try {
		if (!safeStorage.isEncryptionAvailable()) return undefined;
		return safeStorage.decryptString(encrypted);
	} catch {
		return undefined;
	}
}

async function hasStoredToken(): Promise<boolean> {
	try {
		await fs.access(storedTokenPath());
		return true;
	} catch {
		return false;
	}
}

export function resolveUpdateToken(): Promise<ResolvedUpdateToken | undefined> {
	const lookups: [UpdateTokenSource, () => Promise<string | undefined>][] = [
		["env", envToken],
		["gh", ghToken],
		["stored", storedToken],
	];
	return firstUpdateToken(lookups);
}

export function githubApiHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
	return { accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
}

/** Whether `token` can read the release repo. */
export async function checkRepoAccess(token: string): Promise<UpdateAccess> {
	try {
		const response = await net.fetch(GITHUB_API_REPO, { headers: githubApiHeaders(token) });
		return classifyRepoAccess(response.status);
	} catch {
		return "network";
	}
}

export async function updateAuthInfo(): Promise<UpdateAuthInfo> {
	const [resolved, stored] = await Promise.all([resolveUpdateToken(), hasStoredToken()]);
	return {
		source: resolved?.source ?? null,
		hasStoredToken: stored,
		// macOS/Windows always have an OS keystore; probing it would prompt (see top).
		canStore: process.platform !== "linux" || safeStorage.isEncryptionAvailable(),
	};
}

export async function storeUpdateToken(token: string): Promise<void> {
	if (!safeStorage.isEncryptionAvailable())
		throw codedError("safe_storage_unavailable", "safeStorage encryption is unavailable");
	const file = storedTokenPath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, safeStorage.encryptString(token), { mode: 0o600 });
}

export async function clearUpdateToken(): Promise<void> {
	await fs.rm(storedTokenPath(), { force: true });
}
