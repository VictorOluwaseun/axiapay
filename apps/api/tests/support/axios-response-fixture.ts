import {
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

/** Return raw response text at Axios's transport boundary, retaining real client configuration, transformations and provider parsing in tests. */
export function axiosTextResponse(
  text: string,
  status = 200,
  config: InternalAxiosRequestConfig = { headers: new AxiosHeaders() },
): AxiosResponse<string> {
  return {
    data: text,
    status,
    statusText: 'Test response',
    headers: new AxiosHeaders(),
    config,
  };
}
