#!/usr/bin/env bash
# release.yml's `win` and `mac`: wait until this run's `build` job has uploaded
# the `out` artifact (the app bundle, byte-identical on every OS), then download
# it into out/. `needs: build` would start those jobs only after build's whole
# run is over; polling lets them install and set up meanwhile. Needs GH_TOKEN
# with `actions: read`. Fails when build finishes without an artifact.
set -euo pipefail

run="repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
until [ "$(gh api "$run/artifacts?name=out" --jq .total_count)" -gt 0 ]; do
	if [ "$(gh api "$run/jobs?filter=latest&per_page=100" --jq '.jobs[] | select(.name == "build") | .status')" = completed ]; then
		echo "::error::The build job ended without uploading out/."
		exit 1
	fi
	sleep 3
done
gh run download "$GITHUB_RUN_ID" --name out --dir out
