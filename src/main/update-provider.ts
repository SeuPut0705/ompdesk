/**
 * electron-updater provider for releases that ship two plain assets and carry
 * their update metadata in the notes (src/main/update-release.ts) instead of
 * `latest*.yml`. The NSIS flow (download, SHA-512 check, quitAndInstall) runs
 * unchanged on top of it; macOS reads the resolved release through `onResolved`
 * and downloads the DMG itself (src/main/updater.ts).
 *
 * No blockmaps are published, so the updater must run with
 * `disableDifferentialDownload`.
 */
import type { ResolvedUpdateFileInfo, UpdateInfo } from "electron-updater";
import pkg from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import {
	NO_RELEASE_ERROR,
	type PlatformRelease,
	pickRelease,
	RELEASE_LOOKUP_ERROR,
	ReleaseFeedError,
	resolvePlatformRelease,
	UPDATE_METADATA_ERROR,
	type UpdatePlatform,
} from "./update-release";

const { Provider } = pkg;

/** Everything the provider needs from the app; injected so tests run without Electron or the network. */
export interface ReleaseFeed {
	/** `https://api.github.com/repos/<owner>/<repo>` */
	apiRepo: string;
	platform: UpdatePlatform;
	allowPrerelease: boolean;
	/** JSON headers for the release lookup (an Authorization header only when a token is configured). */
	apiHeaders: Record<string, string>;
	/** `application/octet-stream` headers for the asset download (same rule). */
	downloadHeaders: Record<string, string>;
	fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
	/** The release a check resolved, before electron-updater compares versions. */
	onResolved: (release: PlatformRelease) => void;
}

/** electron-updater's view of `release`: one file, named like the asset so NSIS caches it as `.exe`. */
export function releaseUpdateInfo(release: PlatformRelease): UpdateInfo {
	const { name, sha512, size } = release.file;
	return {
		version: release.version,
		releaseDate: release.releaseDate,
		releaseName: release.releaseName,
		releaseNotes: release.notes,
		files: [{ url: name, sha512, size }],
		path: name,
		sha512,
	};
}

/**
 * How long the release lookup may go unanswered. A stalled connection (a captive portal, Wi-Fi that dropped
 * mid-request) never answers and never fails, and the check read "Checking for updates…" until the app quit.
 */
export const RELEASE_LOOKUP_TIMEOUT_MS = 15_000;

async function fetchRelease(feed: ReleaseFeed): Promise<unknown> {
	// GitHub lists newest first; one page reaches any pre-release worth testing.
	const url = feed.allowPrerelease ? `${feed.apiRepo}/releases?per_page=30` : `${feed.apiRepo}/releases/latest`;
	const abort = new AbortController();
	const late = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		abort.abort();
		late.reject(
			new ReleaseFeedError(
				RELEASE_LOOKUP_ERROR,
				`GitHub did not answer within ${RELEASE_LOOKUP_TIMEOUT_MS / 1000} s (${url})`,
			),
		);
	}, RELEASE_LOOKUP_TIMEOUT_MS);
	// The race holds whether or not the fetch honours the signal.
	const response = await Promise.race([
		feed.fetch(url, { headers: feed.apiHeaders, signal: abort.signal }),
		late.promise,
	]).finally(() => clearTimeout(timer));
	// 404 is also what a token without access sees; runCheck asks the repo
	// endpoint before trusting "no release".
	if (response.status === 404) throw new ReleaseFeedError(NO_RELEASE_ERROR, `No published release (${url})`);
	if (!response.ok) throw new ReleaseFeedError(RELEASE_LOOKUP_ERROR, `GitHub answered ${response.status} (${url})`);
	return response.json();
}

/** The provider class `setFeedURL({ provider: "custom", updateProvider })` instantiates. */
export function releaseUpdateProvider(feed: ReleaseFeed) {
	return class ReleaseNotesProvider extends Provider<UpdateInfo> {
		#release: PlatformRelease | undefined;

		constructor(_options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
			super(runtimeOptions);
		}

		get fileExtraDownloadHeaders(): Record<string, string> {
			return feed.downloadHeaders;
		}

		async getLatestVersion(): Promise<UpdateInfo> {
			const release = resolvePlatformRelease(
				pickRelease(await fetchRelease(feed), feed.allowPrerelease),
				feed.platform,
			);
			this.#release = release;
			feed.onResolved(release);
			return releaseUpdateInfo(release);
		}

		resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
			const release = this.#release;
			if (!release || release.version !== info.version) {
				throw new ReleaseFeedError(UPDATE_METADATA_ERROR, `No resolved release for ${info.version}`);
			}
			return info.files.map(file => ({ url: new URL(release.assetUrl), info: file }));
		}
	};
}
