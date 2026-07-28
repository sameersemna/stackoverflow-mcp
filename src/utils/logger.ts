import pino from 'pino';
import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
});

const parsedEnv = envSchema.safeParse({
  LOG_LEVEL: process.env.LOG_LEVEL,
});

const logLevel = parsedEnv.success && parsedEnv.data.LOG_LEVEL ? parsedEnv.data.LOG_LEVEL : 'info';

export const logger = pino(
  {
    level: logLevel,
    redact: ['API_KEY', 'STACKOVERFLOW_API_KEY', 'password', 'authorization'],
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2)
);
