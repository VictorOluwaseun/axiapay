import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
} from 'axios';

/** Bound decoded provider responses and serialized request bodies to 256 KiB. */
export const outboundBodyLimitBytes = 262144;

/** Construct an isolated Node HTTP client with bounded I/O and no redirects or implicit JSON conversion. Callers own URLs, credentials, exact serialization/parsing, absolute deadlines and business error mapping. A test adapter replaces transport only. */
export function createOutboundHttpClient(
  timeoutMs: number,
  adapter: AxiosAdapter | undefined,
): AxiosInstance {
  return axios.create({
    adapter: adapter ?? 'http',
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
}

/** Recognize Axios 1.20's bounded-response rejection without exposing its config, request, response or arbitrary message. Covered through the real Node adapter because Axios shares ERR_BAD_RESPONSE with other stream failures. */
export function isOutboundResponseTooLarge(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.code === AxiosError.ERR_BAD_RESPONSE &&
    error.message ===
      `maxContentLength size of ${outboundBodyLimitBytes} exceeded`
  );
}

/** Classify Axios deadline/cancellation failures without inspecting transport exception text. */
export function isOutboundTimeout(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    (error.code === AxiosError.ETIMEDOUT ||
      error.code === AxiosError.ECONNABORTED ||
      error.code === AxiosError.ERR_CANCELED)
  );
}
