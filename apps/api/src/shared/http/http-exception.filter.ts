import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  Inject,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { HttpErrorResponse, HttpFailure } from './http-failure.js';

/** Allowlisted HTTP messages deliberately ignore exception bodies, including messages on 4xx errors. */
const httpFailures: Readonly<
  Record<number, { code: string; message: string }>
> = {
  400: { code: 'INVALID_INPUT', message: 'Invalid request.' },
  401: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
  403: { code: 'FORBIDDEN', message: 'Access denied.' },
  404: { code: 'NOT_FOUND', message: 'Resource not found.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' },
  406: { code: 'NOT_ACCEPTABLE', message: 'Response format not supported.' },
  408: { code: 'REQUEST_TIMEOUT', message: 'Request timed out.' },
  409: {
    code: 'CONFLICT',
    message: 'Request conflicts with the current state.',
  },
  410: { code: 'GONE', message: 'Resource no longer available.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
  415: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Content type not supported.',
  },
  422: { code: 'UNPROCESSABLE_ENTITY', message: 'Request cannot be applied.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests.' },
  500: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  501: { code: 'NOT_IMPLEMENTED', message: 'Operation not supported.' },
  502: { code: 'BAD_GATEWAY', message: 'An upstream service is unavailable.' },
  503: {
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service temporarily unavailable.',
  },
  504: { code: 'GATEWAY_TIMEOUT', message: 'An upstream service timed out.' },
};

/** Only recognized parser failures may select an HTTP status; arbitrary thrown status/code properties are untrusted. */
const parserStatuses: Readonly<Record<string, number>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 413,
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 415,
  FST_ERR_CTP_EMPTY_JSON_BODY: 400,
  FST_ERR_CTP_INVALID_JSON_BODY: 400,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 400,
};

/** Select a safe response without serializing exception text, causes, stacks, or arbitrary response properties. */
function failureForStatus(status: number): HttpFailure {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return failureForStatus(500);
  }
  return {
    status,
    ...(httpFailures[status] ?? {
      code: 'HTTP_ERROR',
      message: 'Request could not be completed.',
    }),
  };
}

/** Recognize Nest exceptions and Fastify parser failures before feature-specific fallback mapping. */
function transportFailure(error: unknown): HttpFailure | undefined {
  if (error instanceof HttpException) {
    return failureForStatus(error.getStatus());
  }
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  const status =
    typeof error.code === 'string' ? parserStatuses[error.code] : undefined;
  return status === undefined ? undefined : failureForStatus(status);
}

/** Provide one HTTP failure path globally and for scoped feature mappings, with redacted diagnostics and correlated, uncached responses. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  /** Borrow Nest's lifecycle-managed adapter so the filter never owns an HTTP server or writes to a closed response. */
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Apply safe framework mappings first; feature subclasses supply business projections and financial uncertainty guidance. */
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<{ id?: string }>();
    const response: unknown = host.switchToHttp().getResponse();
    const adapter = this.adapterHost.httpAdapter;
    const requestId = request.id ?? randomUUID();
    const failure = transportFailure(error) ?? this.mapFailure(error);
    this.logFailure(failure, requestId);
    if (adapter.isHeadersSent(response)) {
      adapter.end(response);
      return;
    }
    adapter.setHeader(response, 'Cache-Control', 'no-store');
    adapter.setHeader(response, 'Pragma', 'no-cache');
    adapter.setHeader(response, 'X-Request-Id', requestId);
    if (failure.authenticationScheme) {
      adapter.setHeader(
        response,
        'WWW-Authenticate',
        failure.authenticationScheme,
      );
    }
    if (failure.retryAfterSeconds !== undefined) {
      adapter.setHeader(
        response,
        'Retry-After',
        String(failure.retryAfterSeconds),
      );
    }
    const body: HttpErrorResponse = {
      statusCode: failure.status,
      code: failure.code,
      message: failure.message,
      requestId,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    };
    adapter.reply(response, body, failure.status);
  }

  /** Unexpected failures remain server errors; this response makes no claim about a financial operation's outcome. */
  protected mapFailure(error: unknown): HttpFailure {
    return transportFailure(error) ?? failureForStatus(500);
  }

  /** Log bounded classifications and their allowlisted descriptions; raw errors and request content may contain secrets even after generic key redaction. */
  private logFailure(failure: HttpFailure, requestId: string): void {
    const diagnostic = {
      event: 'http_request_failed',
      requestId,
      statusCode: failure.status,
      code: failure.code,
      message: failure.message,
    };
    if (failure.status >= 500) {
      this.logger.error(diagnostic);
      return;
    }
    if (
      failure.status === 401 ||
      failure.status === 403 ||
      failure.status === 429
    ) {
      this.logger.warn(diagnostic);
    }
  }
}
