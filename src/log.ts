export const log = (...parts: unknown[]) =>
  console.log(`[${new Date().toISOString()}]`, ...parts);
