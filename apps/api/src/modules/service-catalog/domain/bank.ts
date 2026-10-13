/** Immutable first-party domestic bank/account profile; operator publication defines supported currency, country and numeric account length without exposing upstream routing. */
export interface Bank {
  readonly id: string;
  readonly bankCode: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly currency: string;
  readonly minimumAccountNumberLength: number;
  readonly maximumAccountNumberLength: number;
  readonly isEnabled: boolean;
}

/** Bounded bank directory identity; callers retain currency/country filters when following a cursor. */
export interface BankQuery {
  readonly currency?: string;
  readonly countryCode?: string;
  readonly afterId?: string;
  readonly limit: number;
}

/** Stable page of enabled first-party bank revisions, ordered by revision identity. */
export interface BankPage {
  readonly banks: readonly Bank[];
  readonly nextCursor: string | null;
}
