#!/usr/bin/env bash
set -euo pipefail

bucket="${SKYNET_R2_BUCKET:-skynet-downloads}"
mode="${1:-current}"

if [[ "$mode" != "current" && "$mode" != "--all" ]]; then
  echo "Usage: $0 [--all]" >&2
  exit 2
fi

upload_artifact() {
  local file="$1"
  local content_type

  if [[ ! -f "$file" ]]; then
    echo "Missing installer: $file" >&2
    exit 1
  fi

  case "$file" in
    *.msi) content_type="application/x-msi" ;;
    *.pkg) content_type="application/vnd.apple.installer+xml" ;;
    *.zip) content_type="application/zip" ;;
    *)
      echo "Refusing unsupported public artifact: $file" >&2
      exit 1
      ;;
  esac

  npx wrangler r2 object put "$bucket/$file" \
    --remote \
    --file "$file" \
    --content-type "$content_type" \
    --content-disposition "attachment; filename=\"$(basename "$file")\"" \
    --cache-control "public, max-age=31536000, immutable"
}

manifest_path_to_file() {
  local value="$1"
  case "$value" in
    https://skynet.matteo-avigni.com/*)
      printf '%s\n' "${value#https://skynet.matteo-avigni.com/}"
      ;;
    downloads/*)
      printf '%s\n' "$value"
      ;;
    *)
      echo "Manifest path is outside the Skynet download host: $value" >&2
      exit 1
      ;;
  esac
}

if [[ "$mode" == "--all" ]]; then
  while IFS= read -r file; do
    upload_artifact "$file"
  done < <(find downloads -type f \( -name '*.msi' -o -name '*.pkg' -o -name '*.zip' \) | sort)
else
  while IFS= read -r manifest_path; do
    upload_artifact "$(manifest_path_to_file "$manifest_path")"
  done < <(jq -er '.windows.path, .macos.path' downloads/latest.json)
fi

