/** Data was readable and a required comparison failed: maps to MISMATCH, never UNAVAILABLE. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
