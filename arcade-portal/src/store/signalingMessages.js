import { SIGNALING_MESSAGE_IDS, buildSignalingMessage } from "./protocol";

export const controllerHostMessage = (workerId) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_HOST,
    sessionID: workerId,
  });

export const controllerJoinMessage = (code) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_JOIN,
    data: code,
  });

export const controllerInputMessage = (hostClientId, payload) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_INPUT,
    sessionID: hostClientId,
    data: payload,
  });

export const controllerAudioMessage = (hostClientId) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_AUDIO,
    sessionID: hostClientId,
    data: "enable",
  });
