import type { Money } from '../../wallets/domain/money.js';
import type {
  FundingEnvironment,
  FundingOption,
  VerifiedFundingPayment,
} from '../domain/funding.js';

/** Minimum checkout terms shared with an external system; wallet ownership and internal request keys never cross this port. */
export interface FundingCheckoutRequest {
  readonly reference: string;
  readonly value: Money;
  readonly payerEmail: string;
}

/** Outbound funding capability owned by AxiaPay. Adapters translate protocols; they never authorize customers or post money. */
export interface FundingAdapter {
  readonly environment: FundingEnvironment;
  readonly partnerAccountId: string;
  /** Submit the already persisted reference once. Return a validated HTTPS checkout URL; uncertainty must throw, never report failure as final. */
  initialize(request: FundingCheckoutRequest): Promise<string>;
  /** Query independently with server credentials, preserving exact minor units and a stable economic payment ID across deliveries. */
  verify(reference: string): Promise<VerifiedFundingPayment>;
}

/** Explicit deployment binding. IDs identify merchant integrations, not an enum of supported vendors; one ID has one account/environment. */
export interface FundingRoute {
  readonly option: FundingOption;
  /** Disable discovery/new requests while retaining verification for existing intents. */
  readonly acceptsNewRequests: boolean;
  readonly adapterId: string;
  readonly adapter: FundingAdapter;
}

/** Verified notification identity only. Provider delivery adapters authenticate raw bytes before constructing this input. */
export interface FundingNotification {
  readonly reference: string;
  readonly externalMovementId: string;
}

/** Trusted inbound port input, scoped to the authenticating deployment binding; it is never accepted from customer JSON. */
export interface AuthenticatedFundingNotification extends FundingNotification {
  readonly adapterId: string;
  readonly environment: FundingEnvironment;
  readonly partnerAccountId: string;
}
