#!/bin/sh
set -eu

cd "$(dirname "$0")"

update_package_lock() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e npm_config_cache=/tmp/npm-cache \
    -v "$PWD:/app" \
    -w /app \
    node:24.20.0-alpine \
    npm update --package-lock-only --ignore-scripts
}

create_config() {
  if [ "$#" -ne 1 ]; then
    echo "Usage: $0 create_config https://app.example.com" >&2
    return 2
  fi

  docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -e npm_config_cache=/tmp/npm-cache \
    --tmpfs "/app/node_modules:rw,exec,uid=$(id -u),gid=$(id -g),mode=0755" \
    -v "$PWD:/app" \
    -w /app \
    node:24.20.0-alpine \
    sh -c 'npm ci --omit=dev --ignore-scripts && npm rebuild argon2 && npm run --silent create-config -- "$@"' \
    sh "$@"
}

"$@"
