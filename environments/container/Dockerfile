# Sprout environment image
#
# The image an environment instance runs in. It contains what the environment
# *worker* needs (Node) and what the *engines* need (here: Codex and a git repo,
# which Codex requires in its working directory).
#
# Built from the repository so a container instance is reproducible, rather than
# depending on a hand-built local image.
#
# A proxy is needed while building and while running whenever the host requires
# one to reach the network; pass it as a build arg rather than baking a value in,
# since a proxy address is a host fact, not a property of the image.

FROM node:24-bookworm-slim

ARG HTTP_PROXY_URL=
ENV HTTP_PROXY=${HTTP_PROXY_URL}
ENV HTTPS_PROXY=${HTTP_PROXY_URL}

# git is required by Codex (it refuses to run outside a git repo) and by Sprout's
# dirty-work detection. `alpine` images ship without it, which is why this image
# is Debian-based.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global user.email "sprout@localhost" \
 && git config --global user.name "Sprout" \
 && git config --global init.defaultBranch main

# The engine the worker hosts. Installed from npm, which is the distribution that
# works; the same version must match what the worker expects.
ARG CODEX_VERSION=0.154.0
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
 && codex --version

# Clear the build-time proxy so it is not silently reused at run time; the
# carrier passes its own proxy settings explicitly per instance.
ENV HTTP_PROXY=
ENV HTTPS_PROXY=

# The worker's working area. A work directory is per-instance state, not part of
# the image.
WORKDIR /sprout
