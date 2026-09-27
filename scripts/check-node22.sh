#!/usr/bin/env bash
# Runs `npm run check` on Node 22.15, the oldest supported version.
# Node is downloaded once into node_modules/.cache: no sudo, nothing global.
set -euo pipefail

v=22.15.0
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "check-node22: unsupported OS" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "check-node22: unsupported CPU" >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
cache="$root/node_modules/.cache"
dir="$cache/node-v$v-$os-$arch"
if [ ! -x "$dir/bin/node" ]; then
  mkdir -p "$cache"
  curl -fsSL "https://nodejs.org/dist/v$v/node-v$v-$os-$arch.tar.gz" | tar -xz -C "$cache"
fi

cd "$root"
PATH="$dir/bin:$PATH" npm run check
