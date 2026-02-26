# Rust Signaling Binary

## Run

```bash
cd arcade-signal
SIGNAL_ADDR=0.0.0.0:8000 cargo run --release
```

Defaults:
- `SIGNAL_ADDR` -> `0.0.0.0:8000`

Endpoints:
- `GET /ws` browser/client websocket endpoint
- `GET /wws` worker websocket endpoint
- `GET /health` simple health check
- `GET /healthz` Kubernetes/Docker health check endpoint
- `GET /` plain text banner

## Supported messages

This implementation mirrors the portal/worker signaling contract:
- Client -> server: `getGames`, `initwebrtc`, `answer`, `candidate`, `joinRoom`, `terminateSession`
- Worker -> server: `gameInfo`, `offer`, `candidate`, `updatePlayerCount`
- Server -> client: `games`, `offer`, `candidate`, `updatePlayerCount`
- Server -> worker: `initwebrtc`, `answer`, `candidate`, `joinRoom`, `terminateSession`
