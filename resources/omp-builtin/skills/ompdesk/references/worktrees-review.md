# Competing attempts in worktrees: compare, then merge

1. Open each attempt with `worktree: true` (branch `omp/agent/<slug>`, its own checkout beside the repo; this computer's sessions only). Its brief says: commit on your branch when done, run the tests, put the result in your final answer.
2. Wait for all: `ompdesk_session_result` with `sessions` and `wait`.
3. `ompdesk_compare` (`sessions`, default your worktree children): branch, commits ahead of the parent, changed files with +/−, uncommitted work, the checks each transcript ran and the final answer. With `criteria` a judge model ranks them and names a winner: skill://ompdesk/references/across.md. It runs no tests itself. Read a thin one with `ompdesk_session_read`.
4. Read each child's work inside its own worktree. A path in its answer that points into the main checkout is not where its work is; never edit there on its behalf.
5. Pick the winner, say why, and `ompdesk_merge` (`session`): a merge commit into the parent checkout's current branch, local, never pushed. The user confirms first unless they turned the card off. It refuses uncommitted work in the child or the parent (ask the child to commit) and aborts a conflicting merge naming the files; then ask the child to rebase or resolve, or tell the user.
6. Your children also wait on the user's work board under "Needs review" with Approve (merge) and Discard. The user may settle them first: read `ompdesk_sessions` before you merge. Close the children when done (`ompdesk_session_stop` with `close`).
