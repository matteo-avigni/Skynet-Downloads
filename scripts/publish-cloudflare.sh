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

upload_metadata() {
  local file="$1"
  local content_type

  [[ -f "$file" ]] || { echo "Missing metadata: $file" >&2; exit 1; }
  case "$file" in
    *.json) content_type="application/json; charset=utf-8" ;;
    *.xml) content_type="application/xml; charset=utf-8" ;;
    *.signature) content_type="text/plain; charset=utf-8" ;;
    *) echo "Refusing unsupported metadata: $file" >&2; exit 1 ;;
  esac

  npx wrangler r2 object put "$bucket/$file" \
    --remote \
    --file "$file" \
    --content-type "$content_type" \
    --cache-control "no-store"
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

upload_metadata downloads/latest.json
if [[ -d updates ]]; then
  while IFS= read -r file; do
    upload_metadata "$file"
  done < <(find updates -type f \( -name 'appcast*.xml' -o -name 'appcast*.xml.signature' \) | sort)
fi

