export function normalizeDomain(input: string | null | undefined): string | null {
  if (input == null) {
    return null;
  }

  const value = input.trim();
  if (value.length === 0) {
    return null;
  }

  try {
    const candidate = value.includes("://") ? value : `https://${value}`;
    const parsed = new URL(candidate);
    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.+$/, "");

    if (
      hostname.length === 0 ||
      !hostname.includes(".") ||
      !/^[a-z0-9.-]+$/.test(hostname)
    ) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
}
