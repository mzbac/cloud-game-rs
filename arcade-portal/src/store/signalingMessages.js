import { SIGNALING_MESSAGE_IDS, buildSignalingMessage } from "./protocol";

export const controllerHostMessage = (workerId) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_HOST,
    targetID: workerId,
  });

export const controllerJoinMessage = (code) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_JOIN,
    data: code,
  });

export const controllerInputMessage = (hostClientId, payload) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_INPUT,
    targetID: hostClientId,
    data: payload,
  });

export const controllerAudioMessage = (hostClientId) =>
  buildSignalingMessage({
    id: SIGNALING_MESSAGE_IDS.CONTROLLER_AUDIO,
    targetID: hostClientId,
    data: "enable",
  });
