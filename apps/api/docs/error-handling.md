# HTTP error handling

`HttpErrorHandlingModule` registers `HttpExceptionFilter` through Nest's `APP_FILTER` provider. The global filter covers controller, middleware, missing-route, and Fastify parsing failures. It lives in the module graph so applications created through Nest testing modules receive the same handler. No new dependency is required.

All handled HTTP errors use this envelope:

```json
{
  "statusCode": 400,
  "code": "INVALID_INPUT",
  "message": "Invalid request.",
  "requestId": "6f66f15b-4e78-4f38-bf01-26d02fcba1fd"
}
```

`statusCode` matches the HTTP status. Clients should branch on `code`; messages are for display and may change. `requestId` also appears in `X-Request-Id` and structured failure diagnostics. Application startup configures Fastify to generate a UUID and copies it to the raw request for Pino correlation. Caller-supplied request ID headers cannot replace it. Every error response sets `Cache-Control: no-store` and `Pragma: no-cache`.

Rate-limited authentication responses preserve `retryAfterSeconds` and the matching `Retry-After` header. Customer session failures retain `WWW-Authenticate: Bearer`; provider webhook authentication failures do not advertise customer bearer authentication.

## Feature boundaries

Authentication, wallet, funding, payment, and conversion filters extend the shared filter and override only `mapFailure`. Their existing business codes, authorization privacy, and financial recovery messages remain feature-owned. The shared `catch` method owns response delivery and logging for every feature; adding a scoped mapper must not introduce another serializer or logger.

Nest `HttpException` statuses are handled before scoped fallback mapping. They use allowlisted messages rather than serializing the exception body. Validation failures return `400 INVALID_INPUT`. Recognized Fastify parser errors retain `400`, `413`, or `415`; arbitrary objects containing `statusCode`, `code`, or `message` do not establish a trusted HTTP error contract. An unclassified global error returns `500 INTERNAL_ERROR`.

Existing financial routes retain their `503` uncertainty responses for unclassified failures. HTTP errors never prove a payment, funding, wallet transfer, or conversion failed financially. Keep the original logical request identity and reconcile existing progress according to the operation's recovery contract. The error handler does not execute retries, settlement, refunds, or other business actions.

## Diagnostics and response recovery

Server errors emit an error-level `http_request_failed` event with request ID, HTTP status, and stable code. Authentication, permission, and rate-limit rejections emit warning-level events. Other expected client errors are left to ordinary access logs. Exception messages, stacks, causes, HTTP bodies, credentials, provider evidence, and arbitrary URLs are not serialized by the failure logger. Add operational context at the owning capability boundary using explicit safe fields rather than logging a raw exception.

If response headers have already been sent, the filter ends the existing response without changing its headers or appending another JSON body. Its failure diagnostic still records the error. An already-started successful response cannot be rewritten into an error envelope.

This boundary applies to HTTP. Non-HTTP adapters still validate their own inputs and own their retry, acknowledgement, and failure protocols. Startup and fatal process failures remain outside this HTTP boundary.

## Verification

`tests/e2e/http-error-handling.spec.ts` exercises the composed application, middleware failures, malformed/empty/oversized bodies, unsupported content types, missing routes, safe HTTP exceptions, non-Error throws, request-reference isolation, feature mappings, retry headers, and financial uncertainty. `src/shared/http/http-exception.filter.spec.ts` covers already-started replies and fallback request references. The wallet HTTP integration suite verifies recovery from a lost response after a committed transfer using the same request key.

Development OpenAPI documents the shared `HttpErrorResponseDto` envelope for all declared error responses and a global `500` response. The implementation follows [Nest's exception-filter and inheritance guidance](https://docs.nestjs.com/exception-filters) and [Fastify's request identity configuration](https://fastify.dev/docs/latest/Reference/Server/#genreqid).
