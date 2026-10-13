/** Report process liveness; this result does not assert database or provider readiness. */
export class GetLivenessUseCase {
  /** Return the process identity used by the liveness probe. */
  execute() {
    return { status: 'ok' as const, service: 'axiapay-api' as const };
  }
}
