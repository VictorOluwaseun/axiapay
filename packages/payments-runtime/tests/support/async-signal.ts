/** Coordinate deterministic concurrent integration-test steps without changing timers or relying on sleeps. */
export function asyncSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
