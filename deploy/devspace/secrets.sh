#!/usr/bin/env bash
# Creates the optional Instagram cookies Secret from ~/.config/cob/cookies.txt (outside the repo).
# Without the file an empty Secret is created and yt-dlp runs logged out.
set -euo pipefail
f="${COB_COOKIES:-$HOME/.config/cob/cookies.txt}"
[ -f "$f" ] || { echo "no cookies file at $f: yt-dlp will run logged out" >&2; : > /tmp/cob-empty-cookies; f=/tmp/cob-empty-cookies; }
kubectl create secret generic cob-cookies --from-file=cookies.txt="$f" --dry-run=client -o yaml | kubectl apply -f -
