# Container environments

A container is the first environment Sprout does not itself run on, which is why
the worker model exists (ADR-0003): the engine runs *inside* the environment, and
the core reaches it over the worker protocol through the container runtime's exec
channel. No port is published.

## Build the image

```bash
npm run image:build                 # builds sprout/environment:latest
```

A proxy is picked up from `HTTPS_PROXY` (or set `SPROUT_DOCKER_PROXY` explicitly)
because the build installs Node packages, and a proxy address is a host fact. The
build also needs `--add-host host.docker.internal:host-gateway` so a
loopback proxy address is reachable from inside the build; the script does this
for you when a proxy is set.

The image is deliberately Debian-based, not Alpine. It needs:

- **`node`** — the environment worker runs inside the container.
- **`git`** — Codex refuses to run outside a git repository, and Sprout's
  dirty-work detection needs it too. `alpine:3.20` ships neither.

## Create an instance

A container instance is a `docker run` of that image, kept alive so a long-lived
worker can be started inside it:

```bash
docker run -d --name sprout-env-1 \
  --add-host host.docker.internal:host-gateway \
  -v "$PWD:/sprout" \
  -v "$HOME/.codex/auth.json:/codexhome/auth.json:ro" \
  -e CODEX_HOME=/codexhome \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  sprout/environment:latest sleep infinity
```

The repository is mounted rather than baked into the image, so a running
container uses the same worker source as the core. That makes a stale image a
mount problem rather than a silent protocol mismatch.

Credentials are **mounted read-only and never copied into an image layer**. The
same is true of the repository: `<repo>/environments/container/Dockerfile` never
contains a token, and `.gitignore` excludes `auth.json`.

## Check it

```bash
npm run smoke:container
```

This crosses the real seams and prints what it observed: the engine visible
inside the container, absent on the host, and Sprout's lease registry refusing a
second concurrent run against the same instance.

## Facts that cost time to learn

- **Docker does not enforce mutual exclusion.** It enforces unique names only;
  two unnamed containers from one image run concurrently. Exclusivity is Sprout's
  lease registry's job.
- **`rm -f` is the only irrecoverable action.** `stop`/`start` preserves a
  container filesystem and `commit`/`export` captures it, so nothing in Sprout
  removes a container implicitly.
- **Codex's own sandbox cannot work in an unprivileged container.** `bwrap`
  cannot create a user namespace, so every turn fails with "No permissions to
  create a new namespace" unless Codex's sandbox is disabled. The worker therefore
  sets `danger-full-access` inside a container, because the container *is* the
  isolation boundary, while a shared host keeps `read-only`.
- **The container's processes are in their own PID namespace**, so the host cannot
  see the engine at all. That absence is how the live check proves the engine runs
  inside the container.
