#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://skynet.matteo-avigni.com}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/skynet-download-verify.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

curl -fsS "$base_url/" -o "$work_dir/index.html"
grep -F "Skynet Installers" "$work_dir/index.html" >/dev/null
grep -F "docs/Skynet-Operator-Handbook.pdf" "$work_dir/index.html" >/dev/null

curl -fsS -D "$work_dir/handbook-headers" -o "$work_dir/handbook.pdf" \
  "$base_url/docs/Skynet-Operator-Handbook.pdf"
grep -Eiq '^content-type: application/pdf' "$work_dir/handbook-headers"
grep -Eiq '^content-disposition: attachment' "$work_dir/handbook-headers"
test "$(head -c 5 "$work_dir/handbook.pdf")" = "%PDF-"

curl -fsS "$base_url/downloads/latest.json" -o "$work_dir/latest.json"
jq -e '.version and .build and .windows.path and .macos.path' "$work_dir/latest.json" >/dev/null

verify_installer() {
  local url="$1"
  local headers="$work_dir/headers"

  case "$url" in
    "$base_url"/downloads/*) ;;
    *)
      echo "Installer URL is outside the canonical host: $url" >&2
      exit 1
      ;;
  esac

  curl -fsSI "$url" -o "$headers"
  grep -Eiq '^content-length: [1-9][0-9]*' "$headers"
  grep -Eiq '^content-disposition: attachment;' "$headers"
  grep -Eiq '^accept-ranges: bytes' "$headers"

  curl -fsS -D "$headers" -o "$work_dir/range.bin" -H 'Range: bytes=0-31' "$url"
  grep -Eiq '^HTTP/[^ ]+ 206' "$headers"
  grep -Eiq '^content-length: 32' "$headers"
  test "$(wc -c < "$work_dir/range.bin" | tr -d ' ')" = 32
}

verify_installer "$(jq -er '.windows.path' "$work_dir/latest.json")"
verify_installer "$(jq -er '.macos.path' "$work_dir/latest.json")"

for feed in appcast.xml appcast-macos.xml; do
  curl -fsS "$base_url/updates/$feed" -o "$work_dir/$feed"
  grep -F '<rss' "$work_dir/$feed" >/dev/null
  grep -F 'sparkle:signature=' "$work_dir/$feed" >/dev/null
  curl -fsS "$base_url/updates/$feed.signature" -o "$work_dir/$feed.signature"
  test -s "$work_dir/$feed.signature"
done

curl -fsS "$base_url/admin/" -o "$work_dir/admin.html"
grep -F "Skynet Release Control" "$work_dir/admin.html" >/dev/null
grep -F "Admin password" "$work_dir/admin.html" >/dev/null
grep -F "Publish installer packages" "$work_dir/admin.html" >/dev/null
grep -F "Publish updater feeds" "$work_dir/admin.html" >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/admin/session")" = 401

test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/.gitignore")" = 404
test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$(jq -er '.macos.path' "$work_dir/latest.json")")" = 405

echo "Cloudflare download verification passed for $base_url"

