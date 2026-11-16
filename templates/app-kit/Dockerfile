# The app's staging image, built by `bun run deploy:staging` on Fly's remote
# builder. The bun pin is the one infra/project-machine/Dockerfile uses.
FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89

WORKDIR /app

# The manifest, the lockfile when `bun install` has made one, and the app kit
# tarball the manifest names, so the install layer is reused until one changes.
COPY package.json bun.lock* ./
COPY vendor ./vendor
RUN bun install

COPY . .
RUN bun run build

# fly.toml sets HOST, PORT, DATA_DIR and APP_ENV, and mounts the volume at
# /data; these are the same values, for a run outside Fly.
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data APP_ENV=staging
EXPOSE 8080
CMD ["bun", "run", "start"]
