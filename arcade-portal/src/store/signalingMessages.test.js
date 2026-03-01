import { describe, it, expect } from "vitest";

import {
  controllerAudioMessage,
  controllerHostMessage,
  controllerInputMessage,
  controllerJoinMessage,
} from "./signalingMessages";

describe("signaling message builders", () => {
  it("builds controllerHostMessage", () => {
    expect(controllerHostMessage("worker-1")).toEqual({
      id: "controllerHost",
      sessionID: "worker-1",
    });
  });

  it("builds controllerJoinMessage", () => {
    expect(controllerJoinMessage("ABCD")).toEqual({
      id: "controllerJoin",
      data: "ABCD",
    });
  });

  it("builds controllerInputMessage", () => {
    expect(controllerInputMessage("host-1", "payload")).toEqual({
      id: "controllerInput",
      sessionID: "host-1",
      data: "payload",
    });
  });

  it("builds controllerAudioMessage", () => {
    expect(controllerAudioMessage("host-1")).toEqual({
      id: "controllerAudio",
      sessionID: "host-1",
      data: "enable",
    });
  });
});

