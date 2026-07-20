import { assertIsoDate } from "./dates";

export function latestByKey<T>(
  items: T[],
  keyOf: (item: T) => string | null,
  dateOf: (item: T) => string
): T[] {
  const latest = new Map<string, T>();

  for (const item of items) {
    const key = keyOf(item);
    if (key === null) {
      continue;
    }

    const candidateDate = assertIsoDate(dateOf(item), "placement date");
    const existing = latest.get(key);
    if (
      !existing ||
      candidateDate > assertIsoDate(dateOf(existing), "placement date")
    ) {
      latest.set(key, item);
    }
  }

  return [...latest.values()];
}
