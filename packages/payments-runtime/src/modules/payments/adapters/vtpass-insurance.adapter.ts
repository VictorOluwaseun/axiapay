import type {
  InsuranceInputOptions,
  InsuranceInputOption,
} from '../ports/insurance-input-options.js';
import type { AxiosAdapter, AxiosInstance } from 'axios';
import {
  createOutboundHttpClient,
  OutboundHttpError,
} from '../../../infrastructure/http/axios-client.js';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { InsuredProfile } from '../domain/insurance-application.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import type {
  InsuranceEligibility,
  InsuranceEligibilityResult,
} from '../ports/insurance-eligibility.js';
import type {
  PaymentDocumentRetrieval,
  RetrievedPaymentDocument,
} from '../ports/payment-document-retrieval.js';
import type { PaymentDocument } from '../domain/payment-document.js';
import {
  formatVtpassPhoneNumber,
  vtpassObject,
  vtpassMinorUnits,
  supportsVtpassPhoneNumber,
} from './vtpass-airtime.protocol.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import { vtpassInsuranceProfiles } from './vtpass-service-profiles.js';
import {
  vtpassEvidenceText,
  vtpassObservationReference,
  vtpassProductSelection,
  type VtpassPurchaseRequest,
} from './vtpass-purchase.protocol.js';

/** Required first-party insured fields for each documented purchase protocol; names and personal details remain independent of VTpass wire keys. */
const insuranceFields = Object.freeze({
  'ui-insure': [
    'fullName',
    'phoneNumber',
    'email',
    'assetReference',
    'engineCapacityBand',
    'chassisNumber',
    'vehicleMake',
    'vehicleModel',
    'vehicleColour',
    'manufactureYear',
    'state',
    'localGovernmentArea',
  ],
  'personal-accident-insurance': [
    'fullName',
    'phoneNumber',
    'address',
    'dateOfBirth',
    'nextOfKinName',
    'nextOfKinPhoneNumber',
    'occupation',
  ],
} as const);

/** Translate insurance purchases and explicit submission-readiness checks. Premium delivery never fabricates policy issuance, insured periods, certificate bytes or active coverage. */
export class VtpassInsuranceAdapter
  extends VtpassServiceAdapter
  implements
    InsuranceEligibility,
    PaymentDocumentRetrieval,
    InsuranceInputOptions
{
  private readonly documents: AxiosInstance;
  /** Keep certificate retrieval isolated from VTpass credentials, using the same bounded transport policy and no redirects. */
  constructor(
    settings: VtpassSettings,
    transport?: AxiosAdapter,
    documentTransport?: AxiosAdapter,
  ) {
    super(settings, vtpassInsuranceProfiles, transport);
    this.documents = createOutboundHttpClient(8000, documentTransport, {
      responseFormat: 'bytes',
      maximumResponseBytes: 10_485_760,
    });
  }
  /** Support only products that explicitly review submission requirements and provider-assigned starts, rather than claiming unavailable underwriting or requested-date APIs. */
  protected override validateService(target: PaymentTermsInput): void {
    const selection = vtpassProductSelection(target.terms.providerProductCode);
    const terms = target.terms.insuranceTerms;
    const required =
      insuranceFields[selection.serviceId as keyof typeof insuranceFields];
    if (
      !terms ||
      !required ||
      terms.eligibilityMode !== 'submission_requirements' ||
      terms.coverageStartMode !== 'provider_assigned' ||
      required.some((field) => !terms.requiredInsuredFields.includes(field))
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    if (target.scope === 'quote') {
      this.assertProfile(
        target.terms.insuranceApplication?.insuredProfile,
        selection.serviceId,
      );
    }
  }
  /** Discover meaningful motor-insurance choices while keeping upstream codes private; dependent options resolve an exact selected make/state. */
  async list(
    input: Parameters<InsuranceInputOptions['list']>[0],
  ): Promise<readonly InsuranceInputOption[]> {
    this.validate({ scope: 'product', terms: input.product });
    if (
      vtpassProductSelection(input.product.providerProductCode).serviceId !==
      'ui-insure'
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    const selections = {
      engineCapacityBand: ['engine-capacity', 'CapacityName'],
      vehicleMake: ['brand', 'VehicleMakeName'],
      vehicleColour: ['color', 'ColourName'],
      state: ['state', 'StateName'],
    } as const;
    if (input.field === 'vehicleModel') {
      const brand = await this.option(
        'brand',
        'VehicleMakeName',
        'VehicleMakeCode',
        input.parentValue!,
      );
      return this.optionChoices(
        `model/${encodeURIComponent(brand)}`,
        'VehicleModelName',
      );
    }
    if (input.field === 'localGovernmentArea') {
      const state = await this.option(
        'state',
        'StateName',
        'StateCode',
        input.parentValue!,
      );
      return this.optionChoices(`lga/${encodeURIComponent(state)}`, 'LGAName');
    }
    const [path, label] = selections[input.field];
    return this.optionChoices(path, label);
  }
  /** Return bounded display/value pairs; duplicate meaningful values are rejected by the application before exposure. */
  private async optionChoices(
    path: string,
    labelKey: string,
  ): Promise<readonly InsuranceInputOption[]> {
    const response = await this.client.get(
      `/api/universal-insurance/options/${path}`,
    );
    if (
      response.response_description !== '000' ||
      !Array.isArray(response.content) ||
      response.content.length > 2000
    ) {
      throw new PaymentError('INSURANCE_UNCONFIRMED');
    }
    return response.content.map((row) => {
      const option = vtpassObject(row);
      assertOptionParent(path, option);
      const value = vtpassEvidenceText(option[labelKey]);
      return { value, label: value };
    });
  }
  /** Check the current premium and authenticated motor-option relationships without paying or representing insurer acceptance. */
  async verify(
    input: Parameters<InsuranceEligibility['verify']>[0],
  ): Promise<InsuranceEligibilityResult> {
    this.validate({ scope: 'product', terms: input.product });
    const selection = vtpassProductSelection(input.product.providerProductCode);
    this.assertProfile(input.insuredProfile, selection.serviceId);
    const response = await this.client.get('/api/service-variations', {
      serviceID: selection.serviceId,
    });
    // The application has already checked immutable product pricing and consent; this checks its provider representation only.
    const content = vtpassObject(response.content);
    const variations = content.variations ?? content.varations;
    if (
      response.response_description !== '000' ||
      content.serviceID !== selection.serviceId ||
      !Array.isArray(variations)
    ) {
      return {
        applicationFingerprint: input.applicationFingerprint,
        eligibilityStatus: 'pending',
      };
    }
    const matches = variations
      .map(vtpassObject)
      .filter((entry) => entry.variation_code === selection.variationCode);
    const variation = matches[0];
    if (matches.length !== 1 || !variation || variation.fixedPrice !== 'Yes') {
      return {
        applicationFingerprint: input.applicationFingerprint,
        eligibilityStatus: 'ineligible',
      };
    }
    if (
      vtpassMinorUnits(variation.variation_amount) !==
      input.product.fixedPriceMinorUnits
    ) {
      return {
        applicationFingerprint: input.applicationFingerprint,
        eligibilityStatus: 'ineligible',
      };
    }
    const translated =
      selection.serviceId === 'ui-insure'
        ? await this.motorOptions(
            this.profileWireFields(input.insuredProfile, selection.serviceId),
          )
        : {};
    return {
      applicationFingerprint: input.applicationFingerprint,
      eligibilityStatus: 'eligible',
      evidenceReference: vtpassObservationReference(
        this.settings.environment,
        'submission-requirements',
        [input.applicationFingerprint],
        { response, translated },
      ),
    };
  }
  /** Map reviewed insured facts; motor option labels are resolved to provider codes inside execution without mutating shared adapter state. */
  protected override requestFields(
    payment: ServicePayment,
    serviceId: string,
  ): Readonly<Record<string, string>> {
    return this.profileWireFields(
      payment.quote.insuranceApplication!.insuredProfile,
      serviceId,
    );
  }
  /** Resolve motor option codes before the one purchase; failed lookups never fall through into payment and never retry the purchase. */
  override async execute(
    request: VtpassPurchaseRequest,
  ): Promise<Record<string, unknown>> {
    if (request.serviceID !== 'ui-insure') {
      return super.execute(request);
    }
    return super.execute({ ...request, ...(await this.motorOptions(request)) });
  }
  /** A motor registration or insured name is the service recipient; the contact phone alone does not identify the insured asset/person. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    const profile = payment.quote.insuranceApplication!.insuredProfile;
    return [
      vtpassProductSelection(payment.quote.providerProductCode).serviceId ===
      'ui-insure'
        ? profile.assetReference!
        : profile.fullName,
    ];
  }
  /** Download only a stored, independently issued policy's allowlisted certificate reference. HTML links are never relabelled as PDF evidence. */
  async retrieve(input: {
    readonly payment: ServicePayment;
    readonly document: PaymentDocument;
  }): Promise<RetrievedPaymentDocument> {
    const reference = input.document.providerDocumentReference;
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new PaymentError('DOCUMENT_UNAVAILABLE');
    }
    if (
      url.origin !== 'https://3rdparty.universalinsuranceonline.com' ||
      url.pathname !== '/PrintCertificate.aspx' ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].join() !== 'Data' ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(url.searchParams.get('Data') ?? '')
    ) {
      throw new PaymentError('DOCUMENT_UNAVAILABLE');
    }
    try {
      const response = await this.documents.request<Buffer>({
        url: url.toString(),
        method: 'GET',
        headers: { Accept: 'application/pdf' },
      });
      const contentType = response.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        contentType.split(';')[0]!.trim().toLowerCase() !== 'application/pdf' ||
        !Buffer.isBuffer(response.data) ||
        response.data.subarray(0, 5).toString('ascii') !== '%PDF-'
      ) {
        throw new PaymentError('DOCUMENT_UNAVAILABLE');
      }
      return {
        paymentId: input.payment.id,
        documentId: input.document.documentId,
        providerDocumentReference: reference,
        contentType: 'application/pdf',
        bytes: response.data,
      };
    } catch (error) {
      if (error instanceof PaymentError) {
        throw error;
      }
      throw new PaymentError('DOCUMENT_UNAVAILABLE', {
        cause: error instanceof OutboundHttpError ? error : undefined,
      });
    }
  }
  /** Require all protocol-specific insured facts without inventing values or storing provider option codes in first-party profiles. */
  private assertProfile(
    profile: InsuredProfile | undefined,
    serviceId: string,
  ): void {
    const required = insuranceFields[serviceId as keyof typeof insuranceFields];
    if (
      !profile ||
      !required ||
      required.some((field) => profile[field] === undefined)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      profile.nextOfKinPhoneNumber &&
      !supportsVtpassPhoneNumber(profile.nextOfKinPhoneNumber)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
  }
  /** Pure wire-name translation, preserving explicit personal details and dates without deriving policy outcomes. */
  private profileWireFields(
    profile: InsuredProfile,
    serviceId: string,
  ): Record<string, string> {
    if (serviceId === 'personal-accident-insurance') {
      return {
        billersCode: profile.fullName,
        full_name: profile.fullName,
        address: profile.address!,
        dob: profile.dateOfBirth!,
        next_kin_name: profile.nextOfKinName!,
        next_kin_phone: formatVtpassPhoneNumber(profile.nextOfKinPhoneNumber!),
        business_occupation: profile.occupation!,
      };
    }
    return {
      billersCode: profile.assetReference!,
      Plate_Number: profile.assetReference!,
      Insured_Name: profile.fullName,
      engine_capacity: profile.engineCapacityBand!,
      Chasis_Number: profile.chassisNumber!,
      vehicle_make: profile.vehicleMake!,
      vehicle_color: profile.vehicleColour!,
      vehicle_model: profile.vehicleModel!,
      YearofMake: profile.manufactureYear!,
      state: profile.state!,
      lga: profile.localGovernmentArea!,
      email: profile.email!,
    };
  }
  /** Resolve exact named motor options and their parent relationships through authenticated GETs; all state belongs to this invocation. */
  private async motorOptions(
    request: Readonly<Record<string, string | undefined>>,
  ): Promise<Readonly<Record<string, string>>> {
    const [brand, colour, capacity, state] = await Promise.all([
      this.option(
        'brand',
        'VehicleMakeName',
        'VehicleMakeCode',
        request.vehicle_make!,
      ),
      this.option('color', 'ColourName', 'ColourCode', request.vehicle_color!),
      this.option(
        'engine-capacity',
        'CapacityName',
        'CapacityCode',
        request.engine_capacity!,
      ),
      this.option('state', 'StateName', 'StateCode', request.state!),
    ]);
    const [model, lga] = await Promise.all([
      this.option(
        `model/${encodeURIComponent(brand)}`,
        'VehicleModelName',
        'VehicleModelCode',
        request.vehicle_model!,
      ),
      this.option(
        `lga/${encodeURIComponent(state)}`,
        'LGAName',
        'LGACode',
        request.lga!,
      ),
    ]);
    return {
      vehicle_make: brand,
      vehicle_color: colour,
      engine_capacity: capacity,
      state,
      vehicle_model: model,
      lga,
    };
  }
  /** Resolve exactly one bounded option label; duplicate names, absent options and malformed codes do not authorize a purchase. */
  private async option(
    path: string,
    labelKey: string,
    codeKey: string,
    label: string,
  ): Promise<string> {
    const response = await this.client.get(
      `/api/universal-insurance/options/${path}`,
    );
    if (
      response.response_description !== '000' ||
      !Array.isArray(response.content)
    ) {
      throw new PaymentError('INSURANCE_UNCONFIRMED');
    }
    const matches = response.content
      .map(vtpassObject)
      .filter((entry) => entry[labelKey] === label);
    if (matches.length !== 1) {
      throw new PaymentError('INSURANCE_INELIGIBLE');
    }
    assertOptionParent(path, matches[0]!);
    const code = vtpassEvidenceText(matches[0]![codeKey], 50);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    return code;
  }
}

/** Reject an explicit parent mismatch even when a provider returns a same-named model or local area from another option group. */
function assertOptionParent(
  path: string,
  option: Readonly<Record<string, unknown>>,
): void {
  const [kind, parent] = path.split('/');
  const parentKey =
    kind === 'model'
      ? 'VehicleMakeCode'
      : kind === 'lga'
        ? 'StateCode'
        : undefined;
  if (
    parentKey &&
    option[parentKey] !== undefined &&
    option[parentKey] !== decodeURIComponent(parent!)
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
}
