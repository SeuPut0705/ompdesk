import type { CopyTarget } from "../../shared/rpc-types";

export interface FlatCopyTarget {
	target: CopyTarget;
	depth: number;
}

/** Flatten the server-owned copy target tree without losing nesting depth. */
export function flattenCopyTargets(targets: readonly CopyTarget[]): FlatCopyTarget[] {
	const flat: FlatCopyTarget[] = [];
	const visit = (items: readonly CopyTarget[], depth: number): void => {
		for (const target of items) {
			flat.push({ target, depth });
			if (target.children) visit(target.children, depth + 1);
		}
	};
	visit(targets, 0);
	return flat;
}
