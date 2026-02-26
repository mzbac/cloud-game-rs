export const startVideoStallDetector = ({ remoteVideoRef, isPeerConnected, setVideoStalled }) => {
  let lastVideoTime = 0;
  let lastVideoAdvanceAt = Date.now();

  const intervalId = window.setInterval(() => {
    if (document.visibilityState === "hidden") {
      return;
    }

    const remoteVideo = remoteVideoRef.current;
    if (!remoteVideo || remoteVideo.readyState < 2 || remoteVideo.videoWidth === 0) {
      return;
    }

    if (!isPeerConnected()) {
      return;
    }

    const now = Date.now();
    const currentTime = remoteVideo.currentTime;
    const advanced = currentTime > lastVideoTime + 0.001;
    if (advanced) {
      lastVideoTime = currentTime;
      lastVideoAdvanceAt = now;
      setVideoStalled(false);
      return;
    }

    if (now - lastVideoAdvanceAt > 3000) {
      setVideoStalled(true);
    }
  }, 1000);

  return () => {
    window.clearInterval(intervalId);
  };
};

