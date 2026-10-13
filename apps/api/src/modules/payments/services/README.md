# payments services

Own cohesive business workflows through repository and capability contracts. Use small methods and focused collaborators; extract a use-case class only for a complex workflow with a clear independent responsibility. Keep domain policies small and precisely named. Do not receive database, Redis, or HTTP request/response objects.

`BillAccountService` owns owner/product-bound TV/electricity verification. `PaymentQuoteService` owns immutable pricing and recipient-bound review. `PaymentExecutionService` owns acceptance, one submission claim, correlation, final evidence and receipt persistence. `WalletPaymentService` coordinates reserve/capture/release and recovery, settling stored financial evidence before optional delayed receipt lookup. Services receive no SQL client, and execution never posts a journal directly.

`EducationRecipientService` owns non-financial beneficiary verification. `InsuranceApplicationService` owns explicit reviewed consent, product-specific insured field validation and correlated eligibility for fixed-premium products. `PaymentDocumentService` authorizes and bounds authenticated PDF delivery using stored descriptors. Financial success, policy issuance and document delivery remain separate; these services never infer active coverage from a paid premium.

`hasProductSubmissionCapabilities` shares required adapter capability checks between catalogue/review availability and new spending authorization. Unfunded accepted instructions recheck these capabilities before holding funds; existing holds keep their original financial recovery obligations.

`BankBeneficiaryService` authenticates name enquiries without spending; `BankTransferService` enforces bank-category ownership and coordinates the shared quote/hold/execution flow. Bank confirmation must match the complete reviewed receiving account and principal before success evidence is stored. Confirmed bank outcomes and actual wallet journal status remain separate, so ledger outages preserve visible credit/failure proof for recovery.
