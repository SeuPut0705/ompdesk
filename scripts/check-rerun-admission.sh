#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  fetch)
    if [ "$EVENT" != workflow_dispatch ] || [ "$RUN_ATTEMPT" = 1 ] || [ -z "${DEVICES// /}" ]; then
      echo 'needed=false' >> "$GITHUB_OUTPUT"
      exit 0
    fi
    [[ "$RUN_ID" =~ ^[1-9][0-9]*$ && "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || exit 1
    statuses=$(gh api --paginate "repos/$REPO/commits/$SHA/statuses?per_page=100")
    receipt=$(printf '%s\n' "$statuses" | jq -sr --arg context "ompdesk-rerun/$RUN_ID/$RUN_ATTEMPT" '
      [ .[][] | select(.context == $context) ] | max_by(.id) | select(.state == "success") | .description // empty')
    if [[ ! "$receipt" =~ ^v1\.([A-Z0-9_]{1,40})\.([0-9]{1,16})\.([0-9a-f]{64})$ ]]; then
      echo '::error::No valid admission receipt for this run attempt. Start the rerun with ompdesk_checks.'
      exit 1
    fi
    echo 'needed=true' >> "$GITHUB_OUTPUT"
    echo "device=${BASH_REMATCH[1]}" >> "$GITHUB_OUTPUT"
    echo "receipt=$receipt" >> "$GITHUB_OUTPUT"
    ;;
  verify)
    if [ "$NEEDED" != true ]; then exit 0; fi
    [[ "$RECEIPT" =~ ^v1\.([A-Z0-9_]{1,40})\.([0-9]{1,16})\.([0-9a-f]{64})$ ]] || exit 1
    device=${BASH_REMATCH[1]}
    expires=${BASH_REMATCH[2]}
    mac=${BASH_REMATCH[3]}
    [[ "$expires" = 0 || "$expires" != 0* ]] || exit 1
    set -f
    known=false
    for listed in ${DEVICES//,/ }; do
      if [ "$listed" = "$device" ]; then known=true; fi
    done
    if [ "$known" != true ] || [ -z "$ADMISSION_KEY" ] || [ "$(( $(date +%s) * 1000 ))" -ge "$expires" ]; then
      echo '::error::The rerun admission receipt is expired or its computer is not authorized.'
      exit 1
    fi
    want=$(printf 'ompdesk-checks-rerun-v1\n%s\n%s\n%s\n%s\n%s\n%s\n%s' "$device" "$REPO" "$REF_NAME" "$SHA" "$RUN_ID" "$RUN_ATTEMPT" "$expires" |
      openssl dgst -sha256 -mac HMAC -macopt "hexkey:$ADMISSION_KEY" -r | cut -d' ' -f1)
    if [ "$want" != "$mac" ]; then
      echo '::error::The rerun admission receipt is not valid for this run attempt.'
      exit 1
    fi
    ;;
  *) exit 2 ;;
esac
