export const parsePlayerCount = (value) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

