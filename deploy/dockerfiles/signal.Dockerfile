# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/library/rust:1.94 AS build
WORKDIR /src

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

ARG SERVICE_DIR=arcade-signal
ARG SERVICE_BINARY=signal
COPY arcade-signal-protocol /src/arcade-signal-protocol
COPY ${SERVICE_DIR} /src/service
WORKDIR /src/service

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/src/service/target \
  cargo build --locked --release --bin ${SERVICE_BINARY} \
  && mkdir -p /out \
  && cp "target/release/${SERVICE_BINARY}" "/out/${SERVICE_BINARY}"

FROM docker.io/library/debian:12-slim
WORKDIR /app
ARG SERVICE_BINARY=signal

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/${SERVICE_BINARY} /app/signal

EXPOSE 8000
ENV SIGNAL_ADDR=:8000

USER 65532:65532
HEALTHCHECK --interval=20s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1
ENTRYPOINT ["/app/signal"]
