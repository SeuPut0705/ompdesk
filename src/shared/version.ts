/**
 * Version order for everything OMPdesk compares: omp, the vendor CLIs, extensions, nvm's node dirs.
 * Semver with prerelease tags (`1.0.0-beta.2` is older than `1.0.0`), an optional leading `v`, any
 * number of dotted parts (`1.2` equals `1.2.0`, `2024.2` is newer than `2024.1.5`), build metadata
 * ignored. PyPI and catalogs sometimes publish versions that cannot be ordered (`1.0rc1`, a commit):
 * `compareVersions` is null for those and `isNewer` falls back to inequality, so a changed version
 * counts as newer rather than hiding an update.
 */

interface Parsed {
	core: number[];
	pre: string[];
}

const SEMVER = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version: string): Parsed | null {
	const match = SEMVER.exec(version.trim());
	if (!match?.[1]) return null;
	return { core: match[1].split(".").map(Number), pre: match[2] ? match[2].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
	// A release outranks any prerelease of the same core.
	if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
		} else if (xn !== yn) {
			return xn ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/** -1, 0 or 1 like `Array.sort`; null when either side is not a dotted-number version. */
export function compareVersions(a: string, b: string): number | null {
	const pa = parse(a);
	const pb = parse(b);
	if (!pa || !pb) return null;
	for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
		const x = pa.core[i] ?? 0;
		const y = pb.core[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return comparePre(pa.pre, pb.pre);
}

/**
 * `latest` is newer than `installed`. An unknown installed version (null) counts as older than anything;
 * versions that cannot be ordered count as newer when they differ.
 */
export function isNewer(latest: string, installed: string | null): boolean {
	if (installed === null) return true;
	const order = compareVersions(latest, installed);
	return order === null ? latest.trim() !== installed.trim() : order > 0;
}

/** An exact version (`1.2.3`, `v1.2.3-beta.1`), as opposed to a range or a dist-tag. */
export function isExactVersion(spec: string): boolean {
	return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec.trim());
}
