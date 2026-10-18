import type { ServiceType } from '../../service-catalog/domain/service-product.js';

/** Global customer payment capabilities, independent of provider registration and individual product publication. */
export type PaymentFeature = ServiceType | 'airtime_conversion';

/** Current application policy. Implementations read a bounded local snapshot, never perform configuration network I/O under payment locks. */
export interface PaymentFeaturePolicy {
  /** Reject unavailable policy; false means explicitly disabled. Existing financial recovery does not depend on this read. */
  isEnabled(feature: PaymentFeature): Promise<boolean>;
}
