#!/usr/bin/env bash
set -euo pipefail

version="8.30.1"
archive="gitleaks_${version}_linux_x64.tar.gz"
download_dir="${RUNNER_TEMP:?RUNNER_TEMP must be set}/gitleaks-${version}"
install_dir="$RUNNER_TEMP/gitleaks-bin"

mkdir -p "$download_dir" "$install_dir"
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}" \
  --output "$download_dir/$archive"
echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $download_dir/$archive" \
  | sha256sum --check --status
tar --extract --gzip --file "$download_dir/$archive" --directory "$install_dir" gitleaks
echo "$install_dir" >> "$GITHUB_PATH"
