import { logWarn } from "./log";

export const ignoreError = (context, err) => {
  if (!context) {
    return;
  }
  logWarn(context, err);
};

export const ignorePromiseRejection = (promise, context) => {
  if (!promise || typeof promise.catch !== "function") {
    return;
  }
  promise.catch((err) => {
    ignoreError(context, err);
  });
};

