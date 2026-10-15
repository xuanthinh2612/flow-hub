/** Only the literal boolean true opts an imported project into Run All. */
export function isAutoGenEnabled(value: unknown): boolean {
  return value === true;
}
