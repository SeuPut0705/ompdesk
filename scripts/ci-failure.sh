#!/usr/bin/env bash
# Run by a job's last step (`if: failure()`): writes the failing job, its failed
# step and the first error lines of its log to the job summary, so the run page
# and `gh run view` show what broke the moment the job ends, not when the whole
# run does. Reads only; needs GH_TOKEN with `actions: read`. Never fails the
# job itself (a missing log only shortens the report).
set -uo pipefail

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
api="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100"

# The job on this runner (runner names are unique per hosted job).
job=$(gh api "$api" --jq ".jobs[] | select(.runner_name == \"${RUNNER_NAME:-}\") | {id, name, url: .html_url, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}" 2>/dev/null | head -n 1)
name=$(jq -r '.name // empty' <<<"$job" 2>/dev/null)
name="${name:-$GITHUB_JOB}"
step=$(jq -r '.steps | join(", ")' <<<"$job" 2>/dev/null)
id=$(jq -r '.id // empty' <<<"$job" 2>/dev/null)
url=$(jq -r '.url // empty' <<<"$job" 2>/dev/null)

{
	echo "### ${GITHUB_WORKFLOW}: \`${name}\` failed"
	echo
	echo "- ref \`${GITHUB_REF_NAME}\`, commit \`${GITHUB_SHA:0:9}\`${url:+, [job log]($url)}"
	[ -n "$step" ] && echo "- failed step: ${step}"
	if [ -n "$id" ]; then
		# The log of a job that is still running ends at the last finished step;
		# the failed step's output is usually there already.
		lines=$(gh api "repos/$GITHUB_REPOSITORY/actions/jobs/$id/logs" 2>/dev/null |
			sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/^[^ ]*Z //' |
			grep -E '(^| )(FAIL|✗|×|error TS[0-9]+|error:|Error:|AssertionError|TypeError|ReferenceError|Timed out|Timeout|Process completed with exit code|##\[error\])|^(Error|error)' |
			head -n 15)
		if [ -n "$lines" ]; then
			echo
			echo '```'
			echo "$lines"
			echo '```'
		fi
	fi
} >>"$summary"
exit 0
