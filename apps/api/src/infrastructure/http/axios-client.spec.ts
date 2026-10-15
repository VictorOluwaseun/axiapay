/** Exercise the installed Axios Node adapter against loopback HTTP, including exact bytes, redirects, decompression limits and both timeout mechanisms. */
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { AxiosError } from 'axios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOutboundHttpClient,
  isOutboundResponseTooLarge,
  isOutboundTimeout,
  outboundBodyLimitBytes,
} from './axios-client.js';

let server: Server;
let origin: string;
let redirectedRequests = 0;

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
    if (request.url === '/large') {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync('x'.repeat(outboundBodyLimitBytes + 1)));
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

  it('returns a redirect for provider classification without following its location', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const response = await client.get(`${origin}/redirect`, {
      headers: { Authorization: 'Bearer local-fixture' },
    });
    expect(response.status).toBe(302);
    expect(redirectedRequests).toBe(0);
  });

  it('bounds decompressed responses and recognizes the pinned Axios size-limit error', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const failure = await client
      .get(`${origin}/large`)
      .catch((error: unknown) => error);
    expect(isOutboundResponseTooLarge(failure)).toBe(true);
    expect(isOutboundTimeout(failure)).toBe(false);
  });

  it('bounds outgoing request bodies before sending them', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    await expect(
      client.post(`${origin}/echo`, 'x'.repeat(outboundBodyLimitBytes + 1)),
    ).rejects.toMatchObject({
      code: AxiosError.ERR_BAD_REQUEST,
    });
  });

  it('classifies the configured Axios timeout without exposing transport text', async () => {
    const client = createOutboundHttpClient(30, undefined);
    const failure = await client
      .get(`${origin}/timeout`)
      .catch((error: unknown) => error);
    expect(isOutboundTimeout(failure)).toBe(true);
    expect(isOutboundResponseTooLarge(failure)).toBe(false);
  });

  it('honours an absolute AbortSignal deadline as an uncertain timeout', async () => {
    const client = createOutboundHttpClient(1000, undefined);
    const failure = await client
      .get(`${origin}/timeout`, {
        signal: AbortSignal.timeout(30),
      })
      .catch((error: unknown) => error);
    expect(isOutboundTimeout(failure)).toBe(true);
  });
});
