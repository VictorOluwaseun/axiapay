/** Verify recovery when a response has already started and when no framework request reference is available. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { HttpExceptionFilter } from './http-exception.filter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP response recovery', () => {
  it('ends an already-started response without changing headers or sending a second error body', () => {
    const adapter = new FastifyAdapter();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = adapter;
    vi.spyOn(adapter, 'isHeadersSent').mockReturnValue(true);
    const end = vi.spyOn(adapter, 'end').mockImplementation(() => undefined);
    const reply = vi.spyOn(adapter, 'reply');
    const setHeader = vi.spyOn(adapter, 'setHeader');
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = {};
    new HttpExceptionFilter(adapterHost).catch(
      new Error('private details'),
      new ExecutionContextHost([{ id: 'server-reference' }, response]),
    );
    expect(end).toHaveBeenCalledExactlyOnceWith(response);
    expect(reply).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'http_request_failed',
      requestId: 'server-reference',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });

  it('uses one generated reference for response headers, body, and diagnostics when the framework supplies none', () => {
    const adapter = new FastifyAdapter();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = adapter;
    vi.spyOn(adapter, 'isHeadersSent').mockReturnValue(false);
    const replyResult = {} as ReturnType<FastifyAdapter['reply']>;
    const reply = vi.spyOn(adapter, 'reply').mockReturnValue(replyResult);
    const setHeader = vi
      .spyOn(adapter, 'setHeader')
      .mockReturnValue(replyResult);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = {};
    new HttpExceptionFilter(adapterHost).catch(
      undefined,
      new ExecutionContextHost([{}, response]),
    );
    const requestId = reply.mock.calls[0]?.[1].requestId;
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(setHeader).toHaveBeenCalledWith(response, 'X-Request-Id', requestId);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      response,
      {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
      500,
    );
  });
});
