/** Safe transport projection owned by HTTP adapters; never include raw exception messages, provider payloads, or credentials. */
export interface HttpFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly authenticationScheme?: 'Bearer';
}

/** Stable error envelope shared by validation, feature, framework, and unexpected HTTP failures. */
export interface HttpErrorResponse {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly retryAfterSeconds?: number;
}
