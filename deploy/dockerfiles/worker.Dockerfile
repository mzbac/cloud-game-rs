# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/library/rust:1.88 AS build
WORKDIR /src

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

ARG SERVICE_DIR=.
ARG SERVICE_BINARY=worker
COPY arcade-signal-protocol /src/arcade-signal-protocol
COPY ${SERVICE_DIR} /src/service
RUN if [ ! -d /src/service/assets ]; then \
    mkdir -p /src/service/assets; \
  fi
WORKDIR /src/service

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/src/service/target \
  cargo build --locked --release --bin ${SERVICE_BINARY} \
  && mkdir -p /out \
  && cp "target/release/${SERVICE_BINARY}" "/out/${SERVICE_BINARY}"

FROM docker.io/library/debian:12-slim
WORKDIR /app
ARG SERVICE_BINARY=worker

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/${SERVICE_BINARY} /app/worker
COPY --from=build /src/service/assets /app/assets

EXPOSE 8081

USER 65532:65532
ENV WORKER_HEALTH_ADDR=:8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD sh -c 'port="${WORKER_HEALTH_ADDR##*:}"; [ -z "$port" ] && port=8081; curl -fsS "http://127.0.0.1:${port}/healthz" || exit 1'
ENTRYPOINT ["/app/worker"]
