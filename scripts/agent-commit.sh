#!/usr/bin/env bash
# Commit only the named paths on top of the CURRENT HEAD, atomically, and refuse a commit that would touch
# anything else. For parallel agents sharing one working tree: the private index is always rebuilt from the
# HEAD it is committed on, so an old index can never be attached to a newer parent (the reverts of 4021e94
# and 770071f). Whole files only: a path whose working copy carries someone else's hunks must be staged
# with --patch-file instead (a `git diff` patch holding only your hunks).
#
#   scripts/agent-commit.sh -m "fix: …" path/a.ts path/b.ts
#   scripts/agent-commit.sh -m "fix: …" --patch-file /tmp/mine.patch
#   add --push to push to origin/main afterwards (rebases onto a moved origin/main by redoing the commit).
set -euo pipefail

msg="" patch="" push=0 paths=()
while [ $# -gt 0 ]; do
	case "$1" in
	-m) msg="$2"; shift 2 ;;
	--patch-file) patch="$2"; shift 2 ;;
	--push) push=1; shift ;;
	*) paths+=("$1"); shift ;;
	esac
done
[ -n "$msg" ] || { echo "agent-commit: -m <message> is required" >&2; exit 2; }
[ -n "$patch" ] || [ ${#paths[@]} -gt 0 ] || { echo "agent-commit: name paths or --patch-file" >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
cd "$root"

commit_once() {
	local head index tree new changed allowed
	head=$(git rev-parse HEAD)
	index=$(mktemp "${TMPDIR:-/tmp}/agent-commit.XXXXXX")
	trap 'rm -f "$index"' RETURN
	GIT_INDEX_FILE="$index" git read-tree "$head"
	if [ -n "$patch" ]; then
		GIT_INDEX_FILE="$index" git apply --cached "$patch"
		allowed=$(git apply --numstat "$patch" | awk '{print $3}' | sort -u)
	else
		GIT_INDEX_FILE="$index" git add -- "${paths[@]}"
		allowed=$(printf '%s\n' "${paths[@]}" | sort -u)
	fi
	# Parse every staged TypeScript blob with its own extension.
	while IFS= read -r file; do
		case "$file" in
		*.ts | *.tsx | *.mts)
			local probe
			probe=$(mktemp "${TMPDIR:-/tmp}/agent-commit-probe.XXXXXX").${file##*.}
			GIT_INDEX_FILE="$index" git show ":$file" >"$probe"
			bun build --no-bundle "$probe" >/dev/null || { rm -f "$probe"; echo "agent-commit: $file does not parse" >&2; return 1; }
			rm -f "$probe"
			;;
		esac
	done < <(GIT_INDEX_FILE="$index" git diff --cached --name-only --diff-filter=AM "$head")
	tree=$(GIT_INDEX_FILE="$index" git write-tree)
	changed=$(git diff --name-only "$head" "$tree" | sort -u)
	[ -n "$changed" ] || { echo "agent-commit: nothing to commit" >&2; return 1; }
	local extra
	extra=$(comm -23 <(echo "$changed") <(echo "$allowed") || true)
	[ -z "$extra" ] || { echo "agent-commit: would also change: $extra" >&2; return 1; }
	new=$(git commit-tree "$tree" -p "$head" -m "$msg")
	# Atomic: fails if HEAD moved since read-tree.
	git update-ref HEAD "$new" "$head"
	echo "$new"
}

commit_once
if [ "$push" = 1 ]; then
	for attempt in 1 2 3; do
		git fetch -q origin main
		if [ "$(git rev-parse origin/main)" != "$(git rev-parse HEAD~1)" ] && ! git merge-base --is-ancestor origin/main HEAD; then
			# origin moved: redo the commit on top of it (never merge, never force).
			mine=$(git rev-parse HEAD)
			git update-ref HEAD "$(git rev-parse origin/main)" "$mine"
			git read-tree HEAD
			commit_once
		fi
		git push origin HEAD:main && exit 0
		echo "agent-commit: push rejected, retrying ($attempt)" >&2
	done
	exit 1
fi
