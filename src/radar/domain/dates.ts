const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function assertIsoDate(value: string, label = "date"): string {
  if (!isIsoDate(value)) {
    throw new Error(`${label} must be a real calendar date in YYYY-MM-DD format`);
  }

  return value;
}

export function isBeforeExclusive(value: string, cutoff: string): boolean {
  assertIsoDate(value, "value");
  assertIsoDate(cutoff, "cutoff");
  return value < cutoff;
}

export function daysBetween(earlier: string, later: string): number {
  assertIsoDate(earlier, "earlier");
  assertIsoDate(later, "later");

  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  const end = Date.parse(`${later}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000);
}
