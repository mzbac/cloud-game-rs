export const safeLocalStorageSetItem = (key, value) => {
  if (!key || typeof key !== "string") {
    return false;
  }

  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }

  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

export const safeLocalStorageGetItem = (key) => {
  if (!key || typeof key !== "string") {
    return null;
  }

  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeJsonToLocalStorage = (key, value) => {
  try {
    return safeLocalStorageSetItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
};
