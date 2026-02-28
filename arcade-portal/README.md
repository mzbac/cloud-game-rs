# Arcade Portal

## Scripts

### `npm start`

Starts the dev server on `http://localhost:8000`.

### `npm test`

Runs the unit tests with Vitest.

### `npm run build`

Builds the production site into the `build/` directory.

### `npm run preview`

Serves the production build locally on `http://localhost:8000`.

### `npm run benchmark:webrtc`

Runs a Playwright-based WebRTC benchmark against a running portal instance and prints a JSON summary.

Example:

```bash
npm run benchmark:webrtc -- --url http://192.168.1.35:8080 --duration 20 --browser chromium
```

## Configuration

The app reads the signaling endpoint from `REACT_APP_SIGNALING_URL`.
If omitted, the default is `ws://localhost:8000/ws`.
You can pass full URLs (`wss://signal.example.com/ws`), host-only values
(`signal.example.com:8000`), or same-origin relative paths (`/ws`).
