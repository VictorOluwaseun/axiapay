/** Share PostgreSQL catalogue row mapping across catalogue reads and locked payment acceptance; no repository, query or business policy is exposed. */
import type { Selectable } from 'kysely';
import type {
  BankTransferBanks,
  ServiceCatalogProducts,
} from '../database.generated.js';
import type { ServiceProduct } from '../../../modules/service-catalog/domain/service-product.js';
import type { InsuranceProductTerms } from '../../../modules/service-catalog/domain/insurance-product-terms.js';
import type { Bank } from '../../../modules/service-catalog/domain/bank.js';

/** Map a product revision to domain terms with exact bigint amounts; eligibility, pricing and transaction ownership remain with callers. */
export function productFromRecord(
  record: Selectable<ServiceCatalogProducts>,
): ServiceProduct {
  return {
    id: record.id,
    serviceType: record.service_type as ServiceProduct['serviceType'],
    networkCode: record.network_code,
    billerCode: record.biller_code,
    electricityMeterType:
      record.electricity_meter_type as ServiceProduct['electricityMeterType'],
    bankId: record.bank_id,
    bankBeneficiaryValidationLifetimeSeconds:
      record.bank_beneficiary_validation_lifetime_seconds,
    accountValidationLifetimeSeconds:
      record.account_validation_lifetime_seconds,
    educationPaymentType:
      record.education_payment_type as ServiceProduct['educationPaymentType'],
    educationPurpose: record.education_purpose,
    educationValidationLifetimeSeconds:
      record.education_validation_lifetime_seconds,
    insuranceTerms:
      record.insurance_terms as unknown as InsuranceProductTerms | null,
    insuranceApplicationLifetimeSeconds:
      record.insurance_application_lifetime_seconds,
    displayName: record.display_name,
    currency: record.currency,
    fixedPriceMinorUnits:
      record.fixed_price_minor_units === null
        ? null
        : BigInt(record.fixed_price_minor_units),
    minimumAmountMinorUnits: BigInt(record.minimum_amount_minor_units),
    maximumAmountMinorUnits: BigInt(record.maximum_amount_minor_units),
    amountStepMinorUnits: BigInt(record.amount_step_minor_units),
    feeMinorUnits: BigInt(record.fee_minor_units),
    allowanceLabel: record.allowance_label,
    validitySeconds: record.validity_seconds,
    quoteLifetimeSeconds: record.quote_lifetime_seconds,
    providerKey: record.provider_key,
    providerProductCode: record.provider_product_code,
    isEnabled: record.is_enabled,
  };
}

/** Map an immutable bank profile to domain terms without applying availability policy or exposing driver types. */
export function bankFromRecord(record: Selectable<BankTransferBanks>): Bank {
  return {
    id: record.id,
    bankCode: record.bank_code,
    displayName: record.display_name,
    countryCode: record.country_code,
    currency: record.currency,
    minimumAccountNumberLength: record.minimum_account_number_length,
    maximumAccountNumberLength: record.maximum_account_number_length,
    isEnabled: record.is_enabled,
  };
}
