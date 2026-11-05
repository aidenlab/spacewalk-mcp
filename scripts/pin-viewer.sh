#!/usr/bin/env bash
# Pin the spacewalk commit the production Viewer page is built from:
#
#   scripts/pin-viewer.sh [<ref>] [--spacewalk <path>]
#
# Fetches spacewalk's origin, resolves <ref> (default origin/main) to its full sha and writes that
# to viewer.pin at the root of this repo. A commit that no branch of origin holds is refused, since
# a release built from it could not be rebuilt elsewhere. Commit the change ("pin spacewalk to
# <short sha>") and merge it by pull request; the next prod- tag ships it. --spacewalk (else
# SPACEWALK_DIR, else the checkout next to this one) says where the spacewalk clone is.
set -euo pipefail

USAGE="usage: scripts/pin-viewer.sh [<ref>] [--spacewalk <path>]"
REF=""
while (($#)); do
  case "$1" in
    --spacewalk) SPACEWALK_DIR="${2:?$USAGE}"; shift 2 ;;
    --spacewalk=*) SPACEWALK_DIR="${1#--spacewalk=}"; shift ;;
    -*) echo "$USAGE" >&2; exit 2 ;;
    *) [[ -z "$REF" ]] || { echo "$USAGE" >&2; exit 2; }; REF="$1"; shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPACEWALK_DIR="${SPACEWALK_DIR:-$REPO_ROOT/../spacewalk}"
[[ -d "$SPACEWALK_DIR/.git" ]] || { echo "no spacewalk checkout at $SPACEWALK_DIR; pass --spacewalk" >&2; exit 1; }
# shellcheck source=scripts/viewer-pin.sh
source "$REPO_ROOT/scripts/viewer-pin.sh"

pin_viewer "$SPACEWALK_DIR" "$REPO_ROOT/viewer.pin" ${REF:+"$REF"}
