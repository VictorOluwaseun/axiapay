/** Minimal response capability used by the HTTP adapter; framework objects never enter configuration workflows. */
export interface RemoteConfigHttpResponse {
  /** Set representation validators and cache policy on both full and bodyless responses. */
  header(name: string, value: string): this;
  /** Select a bodyless conditional response while Nest retains ownership of sending it. */
  code(statusCode: number): this;
}
