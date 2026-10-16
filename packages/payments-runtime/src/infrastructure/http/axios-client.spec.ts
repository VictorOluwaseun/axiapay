/** Exercise the installed Axios Node adapter against loopback HTTP, including exact bytes, redirects, decompression limits and both timeout mechanisms. */
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { inspect } from 'node:util';
import { AxiosError, type AxiosAdapter } from 'axios';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createOutboundHttpClient,
  isOutboundResponseTooLarge,
  isOutboundTimeout,
  outboundBodyLimitBytes,
  OutboundHttpError,
} from './axios-client.js';
import { asyncSignal } from '../../../tests/support/async-signal.js';
import { axiosTextResponse } from '../../../tests/support/axios-response-fixture.js';

let server: Server;
let origin: string;
let redirectedRequests = 0;
const oversizedConnectionClosed = asyncSignal();

beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
      return;
    }
    if (request.url === '/redirect-target') {
      redirectedRequests += 1;
      response.end('unexpected');
      return;
    }
    if (request.url === '/failure') {
      response.writeHead(503, { 'set-cookie': 'private-response-cookie' });
      response.end('private-provider-body');
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync('x'.repeat(outboundBodyLimitBytes + 1)));
      return;
    }
    if (request.url === '/plain-large') {
      response.end('x'.repeat(outboundBodyLimitBytes + 1));
      return;
    }
    if (request.url === '/unicode-large') {
      response.end('é'.repeat(outboundBodyLimitBytes / 2) + 'x');
      return;
    }
    if (request.url === '/exact-limit') {
      response.end('é'.repeat(outboundBodyLimitBytes / 2));
      return;
    }
    if (request.url === '/streaming-large') {
      response.once('close', oversizedConnectionClosed.resolve);
      response.writeHead(200);
      response.write('x'.repeat(outboundBodyLimitBytes + 1));
      return;
    }
    if (request.url === '/truncated') {
      response.writeHead(200, { 'content-length': '200' });
      response.write('partial');
      response.socket?.destroy();
      return;
    }
    if (request.url === '/slow-body') {
      response.writeHead(200);
      response.write('partial');
      return;
    }
    if (request.url === '/timeout') {
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(Buffer.concat(chunks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a loopback TCP address.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('outbound Axios policy', () => {
  it('sends signed JSON unchanged and returns raw numeric tokens for provider-owned parsing', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const body = ' {"id":18446744073709551615,"amount":90071992547409.93} ';
    const response = await client.post<string>(`${origin}/echo`, body, {
      headers: { 'content-type': 'application/json' },
    });
    expect(response.data).toBe(body);
  });

  it('classifies a redirect centrally without following its location', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    await expect(
      client.get(`${origin}/redirect`, {
        headers: { Authorization: 'Bearer local-fixture' },
      }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', httpStatus: 302 });
    expect(redirectedRequests).toBe(0);
  });

  it('retains the HTTP status without retaining request or response secrets', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const failure = await client
      .get(`${origin}/failure`, {
        headers: { Authorization: 'Bearer private-request-key' },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundHttpError);
    expect(failure).toMatchObject({ code: 'HTTP_ERROR', httpStatus: 503 });
    expect(inspect(failure, { depth: 5 })).not.toMatch(/private-/);
    for (const property of ['config', 'request', 'response', 'cause']) {
      expect(failure).not.toHaveProperty(property);
    }
  });

  it.each([
    [AxiosError.ETIMEDOUT, 'TIMEOUT'],
    [AxiosError.ERR_NETWORK, 'REQUEST_FAILED'],
  ] as const)(
    'normalizes %s without retaining Axios credentials or bodies',
    async (transportCode, code) => {
      const transport = vi
        .fn<AxiosAdapter>()
        .mockImplementation(async (config) => {
          throw new AxiosError(
            'private-transport-message',
            transportCode,
            config,
          );
        });
      const client = createOutboundHttpClient(1000, transport);
      const failure = await client
        .post('https://provider.example', 'private-signed-body', {
          headers: { Authorization: 'Bearer private-request-key' },
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OutboundHttpError);
      expect(failure).toMatchObject({ code });
      expect(inspect(failure, { depth: 5 })).not.toMatch(/private-/);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('normalizes a rejected Axios HTTP response without retaining its payload', async () => {
    const transport = vi
      .fn<AxiosAdapter>()
      .mockImplementation(async (config) => {
        throw new AxiosError(
          'private-rejection-message',
          AxiosError.ERR_BAD_RESPONSE,
          config,
          undefined,
          axiosTextResponse('private-provider-body', 429, config),
        );
      });
    const failure = await createOutboundHttpClient(1000, transport)
      .get('https://provider.example')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'HTTP_ERROR', httpStatus: 429 });
    expect(inspect(failure, { depth: 5 })).not.toMatch(/private-/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after request preparation fails', async () => {
    const transport = vi
      .fn<AxiosAdapter>()
      .mockResolvedValue(axiosTextResponse('{}'));
    const client = createOutboundHttpClient(1000, transport);
    client.interceptors.request.use(() => {
      throw new Error('private-request-preparation');
    });
    const failure = await client
      .get('https://provider.example')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'REQUEST_FAILED' });
    expect(inspect(failure, { depth: 5 })).not.toMatch(/private-/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('isolates interceptor state, signed bodies and credentials between clients', async () => {
    const firstTransport = vi
      .fn<AxiosAdapter>()
      .mockResolvedValue(axiosTextResponse('first-response'));
    const secondTransport = vi
      .fn<AxiosAdapter>()
      .mockResolvedValue(axiosTextResponse('second-response'));
    const first = createOutboundHttpClient(1000, firstTransport);
    const second = createOutboundHttpClient(1000, secondTransport);
    first.interceptors.request.use((config) => {
      config.headers.set('X-Local-Policy', 'first');
      return config;
    });
    const responses = await Promise.all([
      first.post('https://first.example', 'first-signed-body', {
        headers: { Authorization: 'Bearer first-key' },
      }),
      second.post('https://second.example', 'second-signed-body', {
        headers: { Authorization: 'Bearer second-key' },
      }),
    ]);
    expect(responses.map((response) => response.data)).toEqual([
      'first-response',
      'second-response',
    ]);
    expect(firstTransport.mock.calls[0]![0]).toMatchObject({
      data: 'first-signed-body',
      headers: { Authorization: 'Bearer first-key', 'X-Local-Policy': 'first' },
    });
    expect(secondTransport.mock.calls[0]![0]).toMatchObject({
      data: 'second-signed-body',
      headers: { Authorization: 'Bearer second-key' },
    });
    expect(
      secondTransport.mock.calls[0]![0].headers.has('X-Local-Policy'),
    ).toBe(false);
  });

  it.each(['large', 'plain-large', 'unicode-large'])(
    'bounds decoded bytes for /%s with our own size-limit failure',
    async (path) => {
      const client = createOutboundHttpClient(1000, undefined);
      const failure = await client
        .get(`${origin}/${path}`)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      expect(isOutboundResponseTooLarge(failure)).toBe(true);
      expect(isOutboundTimeout(failure)).toBe(false);
    },
  );

  it('accepts exactly the byte limit with multibyte UTF-8 text intact', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const response = await client.get<string>(`${origin}/exact-limit`);
    expect(response.data).toBe('é'.repeat(outboundBodyLimitBytes / 2));
    expect(Buffer.byteLength(response.data)).toBe(outboundBodyLimitBytes);
  });

  it('closes an oversized unfinished response and keeps credentials out of the owned error', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const failure = await client
      .get(`${origin}/streaming-large`, {
        headers: { Authorization: 'Bearer private-local-credential' },
      })
      .catch((error: unknown) => error);
    expect(isOutboundResponseTooLarge(failure)).toBe(true);
    await oversizedConnectionClosed.promise;
    expect(inspect(failure, { depth: 5 })).not.toContain(
      'private-local-credential',
    );
  });

  it('preserves UTF-8 decoding and strips a leading byte-order mark', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const response = await client.post<string>(
      `${origin}/echo`,
      '\ufeff{"text":"₦ café 😀"}',
    );
    expect(response.data).toBe('{"text":"₦ café 😀"}');
  });

  it('does not classify a truncated response as a size-limit failure', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const failure = await client
      .get(`${origin}/truncated`)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(isOutboundResponseTooLarge(failure)).toBe(false);
    expect(isOutboundTimeout(failure)).toBe(false);
  });

  it.each([
    new AxiosError('stream interrupted', AxiosError.ERR_BAD_RESPONSE),
    new AxiosError(
      `maxContentLength size of ${outboundBodyLimitBytes} exceeded`,
      AxiosError.ERR_BAD_RESPONSE,
    ),
    new Error('Outbound HTTP response exceeded the supported size limit.'),
  ])('does not infer an overflow from external error text: %s', (failure) => {
    expect(isOutboundResponseTooLarge(failure)).toBe(false);
  });

  it('bounds outgoing request bodies before sending them', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    await expect(
      client.post(`${origin}/echo`, 'x'.repeat(outboundBodyLimitBytes + 1)),
    ).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
    });
  });

  it.each(['timeout', 'slow-body'])(
    'classifies an Axios timeout for /%s without exposing transport text',
    async (path) => {
      const client = createOutboundHttpClient(30, undefined);
      const failure = await client
        .get(`${origin}/${path}`)
        .catch((error: unknown) => error);
      expect(isOutboundTimeout(failure)).toBe(true);
      expect(isOutboundResponseTooLarge(failure)).toBe(false);
    },
  );

  it.each(['timeout', 'slow-body'])(
    'honours an absolute AbortSignal deadline for /%s',
    async (path) => {
      const client = createOutboundHttpClient(1000, undefined);
      const failure = await client
        .get(`${origin}/${path}`, {
          signal: AbortSignal.timeout(30),
        })
        .catch((error: unknown) => error);
      expect(isOutboundTimeout(failure)).toBe(true);
    },
  );
});
