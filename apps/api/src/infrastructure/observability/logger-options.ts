/** Configure redacted HTTP diagnostics without storing request bodies or query strings. */
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';

/** Project a request into the minimal operational fields safe for routine access logs. */
export function serializeRequest(
  request: IncomingMessage & { id?: string | number },
) {
  return {
    id: request.id,
    method: request.method,
    path: request.url?.split('?')[0],
  };
}

/** Supply Pino options through dependency wiring rather than global mutable configuration. */
export function createLoggerOptions(configuration: ConfigService): Params {
  return {
    pinoHttp: {
      level: configuration.getOrThrow<string>('LOG_LEVEL'),
      serializers: { req: serializeRequest },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          'newPassword',
          'token',
          'otp',
        ],
        censor: '[REDACTED]',
      },
    },
  };
}
