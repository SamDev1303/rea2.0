#!/bin/bash
set -euo pipefail

# Register our reviewed source checkout. This script downloads and installs nothing.
fail() { printf 'REA 2.0 registration failed: %s\n' "$1" >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
dry_run=false
while (($# > 0)); do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --no-setup|--no-prompt) shift ;;
    --help|-h) printf 'Usage: install.sh [--dry-run] [--no-setup]\nRegisters the existing local build as ~/.local/bin/rea2; no downloads or setup.\n'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
command -v node >/dev/null 2>&1 || fail 'Node.js must already be installed.'
[[ -f "$root/dist/main.js" && -f "$root/dist/cli.js" ]] || fail 'The local build is missing. Review dependencies and run npm ci --ignore-scripts && npm run build:cached in this checkout first.'
launcher="$root/scripts/rea.mjs"
destination="$HOME/.local/bin/rea2"
if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -L "$destination" && "$(readlink "$destination")" == "$launcher" ]] || fail 'An existing rea2 command is not owned by this checkout; it was preserved.'
fi
printf 'REA 2.0 local registration\n  Source: %s\n  Command: %s\n' "$root" "$destination"
if [[ "$dry_run" == true ]]; then
  printf 'Dry run complete; no changes made.\n'; exit 0
fi
mkdir -p -- "$(dirname -- "$destination")"
if [[ ! -L "$destination" ]]; then ln -s -- "$launcher" "$destination"; fi
printf 'Registered our local build. Run rea2 setup --dry-run to review client configuration.\n'
