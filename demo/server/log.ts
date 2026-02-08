import pino from "pino";

const bootT0 = Date.now();

export const log = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  },
});

/** Milliseconds since server boot — attach to log fields for latency tracking. */
export function bootMs(): number {
  return Date.now() - bootT0;
}
