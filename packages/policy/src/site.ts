// A site as the policy names it (a host name of a list, of an access): shared by the gateway and the contexts.

/** A host name of the list: lowercase, at least two labels, no scheme, port or path (`com` would cover every .com site). */
export function isSiteName(site: string): boolean {
  if (site.length > 253) return false;
  const labels = site.split('.');
  return labels.length >= 2 && labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) && !/^\d+$/.test(labels.at(-1) ?? '');
}
