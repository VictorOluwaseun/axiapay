import { Injectable } from '@nestjs/common';

/** Report process liveness without claiming database, queue, or provider readiness. */
@Injectable()
export class HealthService {
  /** Return the process identity without opening a storage connection. */
  live() {
    return { status: 'ok' as const, service: 'axiapay-api' as const };
  }
}
