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
	check_fresh "$head" || return 1
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
	[ -n "$patch" ] || sync_worktree "$new"
	echo "$new"
}

# After a whole-file commit the named paths are exactly HEAD's: make disk and the shared index say so, so no
# later whole-file commit from this checkout can start from an older copy. Disk is rewritten only when it
# differs from the committed blob (clean filters). Patch commits leave both alone: the working copy holds
# hunks that are not in the commit.
sync_worktree() {
	local new=$1 file blob mode staged
	for file in "${paths[@]}"; do
		blob=$(git rev-parse -q --verify "$new:$file" || true)
		if [ -z "$blob" ]; then
			git update-index --force-remove -- "$file"
			continue
		fi
		mode=$(git ls-tree "$new" -- "$file" | awk '{print $1}')
		staged=$(git hash-object -- "$file" 2>/dev/null || true)
		if [ "$staged" != "$blob" ] && [ -f "$file" ]; then
			git cat-file blob "$blob" >"$file"
		fi
		git update-index --add --cacheinfo "$mode,$blob,$file"
	done
}

# Refuse a whole-file commit of a copy that predates HEAD's version of the path: it would silently delete what
# commits since then added (the reverts of 4021e94, 770071f and a689abd). The copy is judged stale when it equals
# an older committed blob, or when HEAD last changed the path after the file was last written on disk and the
# commit would remove lines of HEAD.
check_fresh() {
	local head=$1 file h w c mtime changed removed
	[ -n "$patch" ] && return 0
	for file in "${paths[@]}"; do
		[ -f "$file" ] || continue
		h=$(git rev-parse -q --verify "$head:$file" || true)
		[ -n "$h" ] || continue
		w=$(git hash-object -- "$file")
		[ "$w" != "$h" ] || continue
		while read -r c; do
			if [ "$(git rev-parse -q --verify "$c:$file" || true)" = "$w" ]; then
				echo "agent-commit: $file on disk is an older committed version (of $c), HEAD has moved on; refusing to revert it." >&2
				echo "agent-commit: re-read HEAD's version, redo your edit, or use --patch-file" >&2
				return 1
			fi
		done < <(git log --format=%H "$head" -- "$file")
		mtime=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file")
		changed=$(git log -1 --format=%ct "$head" -- "$file")
		removed=$(git diff --numstat "$head" -- "$file" | awk '{print $2}')
		if [ "${changed:-0}" -gt "$mtime" ] && [ "${removed:-0}" != 0 ]; then
			echo "agent-commit: $file was changed in HEAD after this copy was last written and the commit would remove $removed line(s) of HEAD; use --patch-file" >&2
			return 1
		fi
	done
}

# Origin ahead of HEAD (someone pushed from another worktree): fast-forward HEAD, bringing the paths origin
# changed to disk and the shared index, unless one of them is dirty on disk (named, nothing moves).
# Diverged histories fail: never move HEAD sideways, never merge, never force.
check_origin() {
	git fetch -q origin main
	local head origin st file old new cur mode dirty=""
	head=$(git rev-parse HEAD) origin=$(git rev-parse origin/main)
	[ "$head" != "$origin" ] || return 0
	git merge-base --is-ancestor origin/main HEAD && return 0
	if ! git merge-base --is-ancestor HEAD origin/main; then
		echo "agent-commit: HEAD and origin/main have diverged; HEAD left untouched. Integrate origin/main, then commit again." >&2
		return 1
	fi
	while IFS=$'\t' read -r st file; do
		old=$(git rev-parse -q --verify "$head:$file" || true)
		new=$(git rev-parse -q --verify "$origin:$file" || true)
		if [ -f "$file" ]; then cur=$(git hash-object -- "$file"); else cur=""; fi
		[ "$cur" = "$old" ] || [ "$cur" = "$new" ] || dirty="$dirty $file"
	done < <(git diff --no-renames --name-status "$head" "$origin")
	if [ -n "$dirty" ]; then
		echo "agent-commit: origin/main is ahead of HEAD and changed files that are dirty on disk:$dirty; HEAD left untouched. Commit or move your edits aside first." >&2
		return 1
	fi
	git update-ref HEAD "$origin" "$head"
	while IFS=$'\t' read -r st file; do
		new=$(git rev-parse -q --verify "$origin:$file" || true)
		if [ -z "$new" ]; then
			rm -f -- "$file"
			git update-index --force-remove -- "$file"
			continue
		fi
		mkdir -p "$(dirname "$file")"
		[ "$(git hash-object -- "$file" 2>/dev/null || true)" = "$new" ] || git cat-file blob "$new" >"$file"
		mode=$(git ls-tree "$origin" -- "$file" | awk '{print $1}')
		[ "$mode" != 100755 ] || chmod +x "$file"
		git update-index --add --cacheinfo "$mode,$new,$file"
	done < <(git diff --no-renames --name-status "$head" "$origin")
	echo "agent-commit: fast-forwarded HEAD to origin/main ($(git rev-parse --short "$origin"))" >&2
}

[ "$push" = 0 ] || check_origin
commit_once
if [ "$push" = 1 ]; then
	for attempt in 1 2 3; do
		check_origin
		git push origin HEAD:main && exit 0
		echo "agent-commit: push rejected, retrying ($attempt)" >&2
	done
	exit 1
fi
