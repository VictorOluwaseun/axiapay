# payments controllers

Map validated HTTP requests to feature service operations. Derive caller identity from trusted authentication. Keep business workflows and storage access out of handlers.

Implemented scope: service preparation, quoted purchase authorization, submission, reconciliation, settlement and issued proof retrieval. Reversals and cancellation execution require separate workflows.

Education/insurance preparation routes map authenticated DTOs into their dedicated services. The document route accepts only first-party payment/document identities, authorizes before external I/O and serves bounded PDF attachments without caching or redirects.
