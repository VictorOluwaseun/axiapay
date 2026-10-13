import type { ServiceType } from '../../service-catalog/domain/service-product.js';
import type { PaymentProviderRegistration } from '../ports/service-payment-provider.js';

/** Share deployment readiness between catalogue/review and spending authorization; presence does not prove provider health or successful fulfilment. */
export function hasProductSubmissionCapabilities(
  serviceType: ServiceType,
  registration: PaymentProviderRegistration,
): boolean {
  if (serviceType === 'bank_transfer') {
    return registration.bankBeneficiaryVerification !== undefined;
  }
  if (serviceType === 'education') {
    return registration.educationVerification !== undefined;
  }
  if (serviceType === 'insurance') {
    return (
      registration.insuranceEligibility !== undefined &&
      registration.documentRetrieval !== undefined
    );
  }
  if (['tv', 'electricity'].includes(serviceType)) {
    return registration.accountVerification !== undefined;
  }
  return true;
}
