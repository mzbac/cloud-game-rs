const IS_DEV =
  import.meta?.env ? Boolean(import.meta.env.DEV) : process.env.NODE_ENV !== "production";

export const logInfo = (...args) => {
  if (IS_DEV) {
    console.info(...args);
  }
};

export const logWarn = (...args) => {
  if (IS_DEV) {
    console.warn(...args);
  }
};

export const logError = (...args) => {
  if (IS_DEV) {
    console.error(...args);
  }
};
