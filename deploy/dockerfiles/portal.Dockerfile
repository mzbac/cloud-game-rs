# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM docker.io/library/node:20-alpine AS build
WORKDIR /app

ENV NODE_ENV=development
ENV GENERATE_SOURCEMAP=false

COPY arcade-portal/package.json arcade-portal/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY arcade-portal/ ./
ARG REACT_APP_SIGNALING_URL=/ws
ARG REACT_APP_SIGNALING_TOKEN=
ENV REACT_APP_SIGNALING_URL=${REACT_APP_SIGNALING_URL}
ENV REACT_APP_SIGNALING_TOKEN=${REACT_APP_SIGNALING_TOKEN}
ENV NODE_ENV=production
RUN npm run build

FROM docker.io/library/nginx:1.27-alpine
WORKDIR /usr/share/nginx/html
RUN apk add --no-cache curl
ARG SIGNAL_BACKEND_HOST=signal
ENV SIGNAL_BACKEND_HOST=${SIGNAL_BACKEND_HOST}

COPY --from=build /app/build .
COPY deploy/nginx/portal.conf /tmp/portal.conf
RUN sed "s|{{SIGNAL_BACKEND_HOST}}|${SIGNAL_BACKEND_HOST}|g" /tmp/portal.conf > /etc/nginx/conf.d/default.conf \
  && rm /tmp/portal.conf

COPY deploy/nginx/portal-entrypoint.sh /portal-entrypoint.sh
RUN chmod +x /portal-entrypoint.sh

EXPOSE 80
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:80/healthz || exit 1

ENTRYPOINT ["/portal-entrypoint.sh"]
