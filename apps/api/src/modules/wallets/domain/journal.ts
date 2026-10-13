import { money } from './money.js';
import { WalletError } from './wallet-error.js';

/** One positive debit or credit; account ownership and currency are checked again in PostgreSQL. */
export interface LedgerEntry {
  readonly accountId: string;
  readonly side: 'debit' | 'credit';
  readonly amountMinorUnits: bigint;
}

/** Balanced event proposed by a service workflow; persistence supplies its immutable identity and timestamp. */
export interface JournalPosting {
  readonly journalKind:
    'funding' | 'transfer' | 'reserve' | 'capture' | 'release';
  readonly currency: string;
  readonly entries: readonly LedgerEntry[];
  readonly reservationId?: string;
  readonly evidenceReference?: string;
}

/** Validate exact arithmetic before sending a posting to the repository. */
export function assertBalancedJournal(posting: JournalPosting): void {
  if (posting.entries.length < 2) {
    throw new WalletError('LEDGER_CONFIGURATION');
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of posting.entries) {
    money(entry.amountMinorUnits, posting.currency);
    if (entry.side === 'debit') {
      debits += entry.amountMinorUnits;
    }
    if (entry.side === 'credit') {
      credits += entry.amountMinorUnits;
    }
  }
  if (debits !== credits || debits === 0n) {
    throw new WalletError('LEDGER_CONFIGURATION');
  }
}
