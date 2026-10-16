/** Reviewed provider protocol metadata. Operator catalogue revisions select variations and prices; these mappings do not publish or price products. */
export interface VtpassServiceProfile {
  readonly productNames: readonly string[];
  readonly transactionType: string;
  readonly requiresVariation: boolean;
  readonly networks?: readonly string[];
  readonly billerCodes?: readonly string[];
}

/** Documented domestic mobile-data services; account-based Smile/Spectranet require their distinct recipient contracts. */
export const vtpassDataProfiles: Readonly<
  Record<string, VtpassServiceProfile>
> = Object.freeze({
  'mtn-data': {
    productNames: ['MTN Data'],
    transactionType: 'Data Services',
    requiresVariation: true,
    networks: ['mtn'],
  },
  'airtel-data': {
    productNames: ['Airtel Data'],
    transactionType: 'Data Services',
    requiresVariation: true,
    networks: ['airtel'],
  },
  'glo-data': {
    productNames: ['GLO Data'],
    transactionType: 'Data Services',
    requiresVariation: true,
    networks: ['glo'],
  },
  'glo-sme-data': {
    productNames: ['GLO SME Data'],
    transactionType: 'Data Services',
    requiresVariation: true,
    networks: ['glo'],
  },
  'etisalat-data': {
    productNames: ['9mobile Data'],
    transactionType: 'Data Services',
    requiresVariation: true,
    networks: ['9mobile', 't2', 'etisalat'],
  },
});

/** Fixed-bouquet, single-month TV purchases; renewal promotions are not silently substituted for the reviewed plan. */
export const vtpassTvProfiles: Readonly<Record<string, VtpassServiceProfile>> =
  Object.freeze({
    dstv: {
      productNames: ['DSTV Subscription'],
      transactionType: 'TV Subscription',
      requiresVariation: true,
      billerCodes: ['dstv'],
    },
    gotv: {
      productNames: ['Gotv Payment'],
      transactionType: 'TV Subscription',
      requiresVariation: true,
      billerCodes: ['gotv'],
    },
    startimes: {
      productNames: ['Startimes Subscription'],
      transactionType: 'TV Subscription',
      requiresVariation: true,
      billerCodes: ['startimes'],
    },
  });

/** Documented DISCO identities for both meter modes. Contradictory copied examples naming a different DISCO are deliberately rejected. */
export const vtpassElectricityProfiles: Readonly<
  Record<string, VtpassServiceProfile>
> = Object.freeze(
  Object.fromEntries(
    [
      [
        'ikeja-electric',
        ['Ikeja Electric Payment - IKEDC'],
        ['ikeja', 'ikedc'],
      ],
      ['eko-electric', ['Eko Electric Payment - EKEDC'], ['eko', 'ekedc']],
      ['kano-electric', ['KEDCO - Kano Electric'], ['kano', 'kedco']],
      [
        'portharcourt-electric',
        ['PHED - Port Harcourt Electric'],
        ['portharcourt', 'phed'],
      ],
      ['jos-electric', ['Jos Electric - JED'], ['jos', 'jed']],
      [
        'ibadan-electric',
        ['IBEDC - Ibadan Electricity Distribution Company'],
        ['ibadan', 'ibedc'],
      ],
      ['kaduna-electric', ['Kaduna Electric - KAEDCO'], ['kaduna', 'kaedco']],
      [
        'abuja-electric',
        ['Abuja Electricity Distribution Company- AEDC'],
        ['abuja', 'aedc'],
      ],
      ['enugu-electric', ['Enugu Electric - EEDC'], ['enugu', 'eedc']],
      [
        'benin-electric',
        ['Benin Electric - BEDC', 'Benin Electricity - BEDC'],
        ['benin', 'bedc'],
      ],
      [
        'aba-electric',
        ['Aba Electric - ABA', 'Aba Electric Payment - ABEDC'],
        ['aba', 'abedc'],
      ],
      [
        'yola-electric',
        ['Yola Electric Disco Payment - YEDC'],
        ['yola', 'yedc'],
      ],
    ].map(([serviceId, productNames, billerCodes]) => [
      serviceId,
      {
        productNames,
        transactionType: 'Electricity Bill',
        requiresVariation: false,
        billerCodes: [serviceId, ...billerCodes!],
      },
    ]),
  ),
);

/** JAMB requires verified candidate evidence; WAEC PIN products use an explicit delivery-phone recipient instead. */
export const vtpassEducationProfiles: Readonly<
  Record<string, VtpassServiceProfile>
> = Object.freeze({
  jamb: {
    productNames: ['JAMB PIN VENDING (UTME & Direct Entry)'],
    transactionType: 'Education',
    requiresVariation: true,
    billerCodes: ['jamb'],
  },
  waec: {
    productNames: ['WAEC Result Checker PIN'],
    transactionType: 'Education',
    requiresVariation: true,
    billerCodes: ['waec'],
  },
  'waec-registration': {
    productNames: ['WAEC Registration PIN'],
    transactionType: 'Education',
    requiresVariation: true,
    billerCodes: ['waec', 'waec-registration'],
  },
});

/** Insurance protocol metadata does not establish underwriting, policy issuance, dates or active coverage. */
export const vtpassInsuranceProfiles: Readonly<
  Record<string, VtpassServiceProfile>
> = Object.freeze({
  'ui-insure': {
    productNames: ['Third Party Motor Insurance - Universal Insurance'],
    transactionType: 'Insurance',
    requiresVariation: true,
    billerCodes: ['universal-insurance', 'ui-insure'],
  },
  'personal-accident-insurance': {
    productNames: ['Personal Accident Insurance'],
    transactionType: 'Insurance',
    requiresVariation: true,
    billerCodes: ['personal-accident-insurance'],
  },
});
