/** Signal absent or expired configuration without disclosing provider credentials or changing authentication policy. */
export class RemoteConfigUnavailableError extends Error {
  /** Retain private failure context for diagnostics while HTTP adapters expose only their safe error classification. */
  constructor(options?: ErrorOptions) {
    super(
      'No current validated application configuration is available.',
      options,
    );
    this.name = 'RemoteConfigUnavailableError';
  }
}
