export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const noop = () => {};
export const silentLogger: Logger = { log: noop, warn: noop, error: noop };
export const consoleLogger: Logger = { log: console.log, warn: console.warn, error: console.error };

let currentLogger: Logger = silentLogger;
export function setLogger(logger: Logger): void { currentLogger = logger; }
export function getLogger(): Logger { return currentLogger; }
