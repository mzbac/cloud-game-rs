import { createGameSessionRuntime } from "./gameSessionRuntime";

export const startWebRtcGameSession = ({
  ...config
}) => {
  const runtime = createGameSessionRuntime(config);
  runtime.start();
  return () => runtime.dispose();
};
