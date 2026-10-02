/** A policy input that cannot be decided safely: the caller must stop, not guess. */
export class PolicyError extends Error {
  override name = 'PolicyError';
}
