#!/usr/bin/env sh
# Copies the rrweb browser bundles into vendor/ as .txt so the Worker can serve them as first-party text.
set -e
mkdir -p vendor
strip() { sed '/^\/\/# sourceMappingURL=/d' "$1" > "$2"; }
strip node_modules/@rrweb/record/dist/record.umd.min.cjs vendor/record.min.txt
strip node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs vendor/player.min.txt
sed '/sourceMappingURL=/d' node_modules/rrweb-player/dist/style.min.css > vendor/player.css.txt
echo "vendored rrweb $(node -p "require('./node_modules/@rrweb/record/package.json').version")"
