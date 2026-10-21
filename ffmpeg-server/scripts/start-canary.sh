#!/usr/bin/env bash
# Run on the first VPS only. Does not mount disks or resume API admission.
set -euo pipefail
compose_file=${1:-/opt/v4c-ffmpeg-canary/ffmpeg-server/compose.canary.json}
quota_mount=${FFMPEG_CANARY_MOUNT:-/srv/v4c-ffmpeg-canary}
if ! mountpoint -q "$quota_mount"; then
  echo 'Refusing start: bounded media filesystem is not mounted.' >&2
  exit 1
fi
if [[ $(findmnt -n -o FSTYPE --target "$quota_mount") != xfs ]]; then
  echo 'Refusing start: expected XFS media filesystem.' >&2
  exit 1
fi
for dir in workspace outputs; do
  [[ -d "$quota_mount/$dir" ]] || { echo "Missing media directory: $dir" >&2; exit 1; }
done
root_free=$(df -B1 --output=avail / | tail -n 1 | tr -d ' ')
if (( root_free < 16106127360 )); then
  echo 'Refusing start: less than 15 GiB available on root filesystem.' >&2
  exit 1
fi
# Validation must not print interpolated secrets.
docker compose -f "$compose_file" config --quiet
docker compose -f "$compose_file" up -d
