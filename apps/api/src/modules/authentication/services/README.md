# authentication services

Own cohesive business workflows through repository and capability contracts. Use small methods and focused collaborators; extract a use-case class only for a complex workflow with a clear independent responsibility. Keep domain policies small and precisely named. Do not receive database, Redis, or HTTP request/response objects.

`DeviceAuthenticationService` owns recent-primary enrollment, signature challenges, device login, owner-scoped listing, and revocation. It uses repository and crypto ports and shares the existing session issuance contract. Device signatures never grant fresh primary authority for enrollment.
