#!/bin/sh
# Build the Sprout environment image.
#
# Usage:
#   environments/container/build.sh [image-tag]
#
# A proxy is passed through when the host needs one, because the build installs
# Node packages and a proxy address is a host fact.

set -eu

tag="${1:-sprout/environment:latest}"
here="$(cd "$(dirname "$0")" && pwd)"

proxy="${SPROUT_DOCKER_PROXY:-${HTTPS_PROXY:-${https_proxy:-}}}"

args=""
if [ -n "$proxy" ]; then
  # The build runs inside Docker's network, where the host is reachable under
  # this name rather than on loopback.
  container_proxy="$(printf '%s' "$proxy" | sed 's#127\.0\.0\.1#host.docker.internal#g; s#localhost#host.docker.internal#g')"
  args="--build-arg HTTP_PROXY_URL=$container_proxy --add-host host.docker.internal:host-gateway"
  echo "building with proxy: $container_proxy"
fi

# shellcheck disable=SC2086
DOCKER_BUILDKIT=1 docker build $args -t "$tag" -f "$here/Dockerfile" "$here"

echo "built $tag"
