import { Readable } from 'node:stream';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
} from 'axios';

/** Bound decoded provider responses and serialized request bodies to 256 KiB. */
export const outboundBodyLimitBytes = 262144;

/** Controlled transport descriptions never accept upstream bodies, headers, request configuration or arbitrary exception messages. */
const outboundHttpErrorMessages = Object.freeze({
  HTTP_ERROR: 'Outbound HTTP endpoint returned a non-success status.',
  TIMEOUT: 'Outbound HTTP request timed out or was cancelled.',
  RESPONSE_TOO_LARGE:
    'Outbound HTTP response exceeded the supported size limit.',
  REQUEST_FAILED: 'Outbound HTTP request failed; its outcome is unconfirmed.',
});

/** Safe shared HTTP failure. The optional status is the endpoint's HTTP status, not a payment result. No raw Axios error or cause is retained. */
export class OutboundHttpError extends Error {
  /** Expose only a controlled classification and HTTP status so feature adapters can map their own business errors. */
  constructor(
    readonly code: keyof typeof outboundHttpErrorMessages,
    readonly httpStatus?: number,
  ) {
    super(outboundHttpErrorMessages[code]);
    this.name = 'OutboundHttpError';
  }
}

/** Construct an isolated Node HTTP client with bounded I/O and per-instance request/response interceptors. Shared deadlines and safe HTTP errors stay here; callers own URLs, credentials, exact serialization/parsing and business error mapping. A test adapter replaces transport only. */
export function createOutboundHttpClient(
  timeoutMs: number,
  adapter: AxiosAdapter | undefined,
): AxiosInstance {
  const transport = axios.getAdapter(adapter ?? 'http');
  const client = axios.create({
    /** Count decoded bytes before buffering; Node async iteration destroys the stream on overflow or failure. */
    adapter: async (config) => {
      const response: AxiosResponse<Readable | string | Buffer> =
        await transport({
          ...config,
          responseType: 'stream',
          // This reader owns the limit and its error type; Axios uses a shared error code for multiple stream failures.
          maxContentLength: -1,
        });
      const body: AsyncIterable<Uint8Array | string> =
        typeof response.data === 'string' || Buffer.isBuffer(response.data)
          ? Readable.from([response.data])
          : response.data;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      for await (const chunk of body) {
        const bytes =
          typeof chunk === 'string'
            ? Buffer.from(chunk, 'utf8')
            : Buffer.from(chunk);
        receivedBytes += bytes.length;
        if (receivedBytes > outboundBodyLimitBytes) {
          throw new OutboundHttpError('RESPONSE_TOO_LARGE');
        }
        chunks.push(bytes);
      }
      const text = Buffer.concat(chunks, receivedBytes).toString('utf8');
      return {
        ...response,
        // Preserve the Axios UTF-8 text contract, including stripping a leading byte-order mark.
        data: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      };
    },
    timeout: timeoutMs,
    maxRedirects: 0,
    maxContentLength: outboundBodyLimitBytes,
    maxBodyLength: outboundBodyLimitBytes,
    responseType: 'text',
    responseEncoding: 'utf8',
    transformRequest: [],
    transformResponse: [],
    validateStatus: null,
    proxy: false,
    transitional: { clarifyTimeoutError: true },
  });

  /** Retain caller cancellation and enforce the configured deadline through the full response read, without modifying signed bytes or credentials. */
  client.interceptors.request.use((config) => {
    const requestTimeoutMs = config.timeout ?? timeoutMs;
    const callerSignal = config.signal as AbortSignal | undefined;
    const deadline =
      requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;
    const signals = [callerSignal, deadline].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    config.signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    return config;
  });

  client.interceptors.response.use(
    /** Reject non-success HTTP statuses centrally without interpreting the provider's business payload. */
    (response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new OutboundHttpError('HTTP_ERROR', response.status);
      }
      return response;
    },
    /** Preserve owned classifications and replace payload-bearing transport exceptions with safe failures; never retry a request here. */
    (error: unknown): never => {
      if (error instanceof OutboundHttpError) {
        throw error;
      }
      const httpStatus = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
        throw new OutboundHttpError('HTTP_ERROR', httpStatus);
      }
      throw new OutboundHttpError(
        isOutboundTimeout(error) ? 'TIMEOUT' : 'REQUEST_FAILED',
      );
    },
  );
  return client;
}

/** Recognize only our owned size-limit failure; Axios messages and generic stream errors never establish a response overflow. */
export function isOutboundResponseTooLarge(error: unknown): boolean {
  return (
    error instanceof OutboundHttpError && error.code === 'RESPONSE_TOO_LARGE'
  );
}

/** Recognize shared timeout failures or raw Axios deadline/cancellation codes during normalization, without inspecting exception text. */
export function isOutboundTimeout(error: unknown): boolean {
  if (error instanceof OutboundHttpError) {
    return error.code === 'TIMEOUT';
  }
  return (
    axios.isAxiosError(error) &&
    (error.code === AxiosError.ETIMEDOUT ||
      error.code === AxiosError.ECONNABORTED ||
      error.code === AxiosError.ERR_CANCELED)
  );
}
