interface YouTubeChannelReferenceBase {
  requestKey: string;
  lookupUrl: string;
  /**
   * Compatibility aliases for callers that have not migrated to the
   * reference terminology yet. A legacy reference is not a verified identity.
   */
  key: string;
  canonicalUrl: string;
}

export interface YouTubeHandleReference
  extends YouTubeChannelReferenceBase {
  kind: "handle";
  handle: string;
}

export interface YouTubeChannelIdReference
  extends YouTubeChannelReferenceBase {
  kind: "channel_id";
  channelId: string;
}

export interface YouTubeLegacyUserReference
  extends YouTubeChannelReferenceBase {
  kind: "legacy_user";
  slug: string;
}

export interface YouTubeLegacyCustomReference
  extends YouTubeChannelReferenceBase {
  kind: "legacy_custom";
  slug: string;
}

export type YouTubeChannelReference =
  | YouTubeHandleReference
  | YouTubeChannelIdReference
  | YouTubeLegacyUserReference
  | YouTubeLegacyCustomReference;

/**
 * @deprecated A parsed user input is a reference, not a verified identity.
 * Use YouTubeChannelReference for new code.
 */
export type YouTubeIdentity = YouTubeChannelReference;

export type YouTubeTargetVerificationCode =
  | "target_not_verified"
  | "target_identity_mismatch"
  | "target_identity_ambiguous";

export type VerifiedYouTubeIdentity =
  | {
      verificationBasis: "channel_id";
      channelId: string;
      handle: string | null;
      canonicalUrl: string;
      key: string;
    }
  | {
      verificationBasis: "exact_unique_handle";
      channelId: null;
      handle: string;
      canonicalUrl: string;
      key: string;
    };

export function sameVerifiedYouTubeIdentity(
  first: VerifiedYouTubeIdentity,
  second: VerifiedYouTubeIdentity
): boolean {
  if (
    first.verificationBasis === "channel_id" &&
    second.verificationBasis === "channel_id"
  ) {
    return first.channelId === second.channelId;
  }
  if (
    first.verificationBasis === "exact_unique_handle" &&
    second.verificationBasis === "exact_unique_handle"
  ) {
    return first.key === second.key;
  }
  return false;
}

export interface VerifiedYouTubeChannelSelection {
  channel: CreatorChannel;
  identity: VerifiedYouTubeIdentity;
}

export class YouTubeTargetVerificationError extends Error {
  constructor(
    readonly code: YouTubeTargetVerificationCode,
    message: string
  ) {
    super(message);
    this.name = "YouTubeTargetVerificationError";
  }
}

export interface CreatorChannel {
  platform: string;
  handle: string;
  url: string;
  displayName: string;
  subscriberCount: number | null;
  platformId?: string | null;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com"
]);
const YOUTUBE_HANDLE_PATTERN = /^[\p{L}\p{N}\p{M}_.-]+$/u;
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]+$/;
const ABSOLUTE_URL_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/;
const HTTP_ABSOLUTE_URL_PATTERN = /^https?:\/\/[^/\\?#\s]/i;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
const DOT_PATH_SEGMENT_PATTERN =
  /(?:^|\/)(?:(?:\.|%2e){1,2})(?=\/|[?#]|$)/i;
const SCHEMELESS_YOUTUBE_URL_PATTERN =
  /^(?:www\.|m\.)?youtube\.com(?:[/?#]|$)/i;

export function parseYouTubeChannelReference(
  input: string
): YouTubeChannelReference {
  const value = input.trim();
  if (!value) {
    throw new Error("Enter a YouTube channel handle or URL");
  }
  if (
    ASCII_CONTROL_PATTERN.test(value) ||
    value.includes("\\") ||
    DOT_PATH_SEGMENT_PATTERN.test(value)
  ) {
    throw new Error("Enter a valid YouTube channel URL");
  }

  if (value.startsWith("@")) {
    return identityForHandle(value.slice(1));
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return referenceForUrl(new URL(value, "https://www.youtube.com"));
  }

  if (value.startsWith("//")) {
    if (!/^\/\/[^/]/.test(value)) {
      throw new Error("Enter a valid YouTube channel URL");
    }
    return referenceForUrl(parseAbsoluteUrl(`https:${value}`));
  }

  if (SCHEMELESS_YOUTUBE_URL_PATTERN.test(value)) {
    return referenceForUrl(parseAbsoluteUrl(`https://${value}`));
  }

  if (ABSOLUTE_URL_PATTERN.test(value)) {
    const protocol = value.slice(0, value.indexOf(":")).toLowerCase();
    if (
      (protocol === "http" || protocol === "https") &&
      !HTTP_ABSOLUTE_URL_PATTERN.test(value)
    ) {
      throw new Error("Enter a valid YouTube channel URL");
    }
    return referenceForUrl(parseAbsoluteUrl(value));
  }

  if (YOUTUBE_HANDLE_PATTERN.test(value)) {
    if (YOUTUBE_HOSTS.has(value.toLowerCase())) {
      throw new Error("The URL must identify a YouTube channel");
    }
    return identityForHandle(value);
  }

  throw new Error("Enter a YouTube channel handle or URL");
}

export function parseYouTubeIdentity(input: string): YouTubeIdentity {
  return parseYouTubeChannelReference(input);
}

function referenceForUrl(parsed: URL): YouTubeChannelReference {
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP or HTTPS YouTube channel URLs are supported");
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Only YouTube channel URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("YouTube channel URLs cannot contain credentials");
  }
  if (parsed.port) {
    throw new Error("YouTube channel URLs cannot use a nonstandard port");
  }

  const pathname = stripOneTrailingSlash(parsed.pathname);
  if (pathname.includes("//")) {
    throw new Error("The URL must contain one exact YouTube channel path");
  }

  const segments = pathname
    .split("/")
    .slice(1)
    .map(decodePathSegment);
  if (segments.length === 0) {
    throw new Error("The URL must identify a YouTube channel");
  }

  if (segments.length === 1 && segments[0].startsWith("@")) {
    return identityForHandle(segments[0].slice(1));
  }

  if (
    segments.length === 2 &&
    segments[0].toLowerCase() === "channel"
  ) {
    const identifier = normalizeIdentifier(segments[1]);
    if (!YOUTUBE_CHANNEL_ID_PATTERN.test(identifier)) {
      throw new Error("YouTube channel ID contains unsupported characters");
    }
    return channelIdReference(identifier);
  }

  if (segments.length === 2 && segments[0].toLowerCase() === "user") {
    return legacyReference("legacy_user", segments[1]);
  }

  if (segments.length === 2 && segments[0].toLowerCase() === "c") {
    return legacyReference("legacy_custom", segments[1]);
  }

  throw new Error("The URL must identify a YouTube channel, not a video");
}

export function selectRequestedYouTubeChannel(
  channels: CreatorChannel[],
  requestedInput: string
): CreatorChannel {
  return selectVerifiedYouTubeChannel(channels, requestedInput).channel;
}

export function selectVerifiedYouTubeChannel(
  channels: CreatorChannel[],
  requestedInput: string | YouTubeChannelReference,
  responseRequestedUrl?: string | null
): VerifiedYouTubeChannelSelection {
  const requested =
    typeof requestedInput === "string"
      ? parseYouTubeChannelReference(requestedInput)
      : requestedInput;
  const candidates = channels.flatMap((channel) => {
    const candidate = verifiedCandidate(channel);
    return candidate === null ? [] : [candidate];
  });

  if (
    requested.kind === "legacy_user" ||
    requested.kind === "legacy_custom"
  ) {
    return selectLegacyReference(
      candidates,
      requested,
      responseRequestedUrl
    );
  }

  const selected = selectDirectReference(candidates, requested);
  if (responseRequestedUrl !== undefined) {
    assertDirectResponseMapping(
      requested,
      selected.identity,
      responseRequestedUrl
    );
  }
  return selected;
}

interface VerifiedCandidate {
  channel: CreatorChannel;
  urlReference: YouTubeHandleReference | YouTubeChannelIdReference;
  handle: string | null;
  handleKey: string | null;
  channelId: string | null;
}

function verifiedCandidate(
  channel: CreatorChannel
): VerifiedCandidate | null {
  if (channel.platform.trim().toLowerCase() !== "youtube") {
    return null;
  }

  let urlReference: YouTubeChannelReference;
  try {
    urlReference = parseProviderCanonicalChannelUrl(channel.url);
  } catch {
    return null;
  }
  if (
    urlReference.kind !== "handle" &&
    urlReference.kind !== "channel_id"
  ) {
    return null;
  }

  const declaredHandle = parseDeclaredHandle(channel.handle);
  if (
    urlReference.kind === "handle" &&
    declaredHandle !== null &&
    declaredHandle.requestKey !== urlReference.requestKey
  ) {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned conflicting YouTube handle evidence"
    );
  }

  const platformId = parsePlatformId(channel.platformId);
  if (
    platformId !== null &&
    urlReference.kind === "channel_id" &&
    platformId !== urlReference.channelId
  ) {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned conflicting YouTube channel IDs"
    );
  }

  const handleReference =
    urlReference.kind === "handle" ? urlReference : declaredHandle;
  return {
    channel,
    urlReference,
    handle: handleReference?.handle ?? null,
    handleKey: handleReference?.requestKey ?? null,
    channelId:
      platformId ??
      (urlReference.kind === "channel_id"
        ? urlReference.channelId
        : null)
  };
}

function selectDirectReference(
  candidates: VerifiedCandidate[],
  requested: YouTubeHandleReference | YouTubeChannelIdReference
): VerifiedYouTubeChannelSelection {
  if (requested.kind === "channel_id") {
    const matches = candidates.filter(
      (candidate) => candidate.channelId === requested.channelId
    );
    if (matches.length === 0) {
      const returnedIds = new Set(
        candidates.flatMap((candidate) =>
          candidate.channelId === null ? [] : [candidate.channelId]
        )
      );
      throw verificationError(
        returnedIds.size > 0
          ? "target_identity_mismatch"
          : "target_not_verified",
        "Upriver did not verify the exact requested YouTube channel ID"
      );
    }
    assertNoConflictingIdForMatchedHandles(
      candidates,
      matches,
      requested.channelId
    );
    return selectOneChannelId(matches);
  }

  const matches = candidates.filter(
    (candidate) => candidate.handleKey === requested.requestKey
  );
  if (matches.length === 0) {
    throw verificationError(
      "target_not_verified",
      "Upriver did not verify the exact requested YouTube channel handle"
    );
  }

  const idBacked = matches.filter(
    (
      candidate
    ): candidate is VerifiedCandidate & { channelId: string } =>
      candidate.channelId !== null
  );
  if (idBacked.length > 0) {
    const matchingIds = new Set(
      idBacked.map((candidate) => candidate.channelId)
    );
    if (matchingIds.size !== 1) {
      return selectOneChannelId(idBacked);
    }
    const [matchingId] = [...matchingIds];
    return selectOneChannelId(
      candidates.filter(
        (candidate) => candidate.channelId === matchingId
      )
    );
  }

  const fallbackMatches = matches.filter(
    (candidate) =>
      candidate.urlReference.kind === "handle" &&
      parseDeclaredHandle(candidate.channel.handle)?.requestKey ===
        requested.requestKey
  );
  if (fallbackMatches.length !== 1 || matches.length !== 1) {
    const ambiguous = matches.length > 1;
    throw verificationError(
      ambiguous ? "target_identity_ambiguous" : "target_not_verified",
      ambiguous
        ? "Upriver returned an ambiguous exact YouTube handle result"
        : "Upriver did not provide matching handle evidence"
    );
  }

  const [candidate] = fallbackMatches;
  return {
    channel: candidate.channel,
    identity: {
      verificationBasis: "exact_unique_handle",
      channelId: null,
      handle: candidate.handle ?? requested.handle,
      canonicalUrl: identityForHandle(
        candidate.handle ?? requested.handle
      ).lookupUrl,
      key: requested.requestKey
    }
  };
}

function selectLegacyReference(
  candidates: VerifiedCandidate[],
  requested:
    | YouTubeLegacyUserReference
    | YouTubeLegacyCustomReference,
  responseRequestedUrl: string | null | undefined
): VerifiedYouTubeChannelSelection {
  if (!responseRequestedUrl) {
    throw verificationError(
      "target_not_verified",
      "Upriver did not return verification for the legacy YouTube URL"
    );
  }

  let responseReference: YouTubeChannelReference;
  try {
    responseReference = parseProviderRequestedYouTubeUrl(
      responseRequestedUrl
    );
  } catch {
    throw verificationError(
      "target_not_verified",
      "Upriver returned an invalid requested YouTube URL"
    );
  }

  if (
    responseReference.kind === "handle" ||
    responseReference.kind === "channel_id"
  ) {
    return selectDirectReference(candidates, responseReference);
  }

  if (responseReference.requestKey !== requested.requestKey) {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned a different legacy YouTube URL"
    );
  }

  const idBacked = candidates.filter(
    (
      candidate
    ): candidate is VerifiedCandidate & { channelId: string } =>
      candidate.channelId !== null
  );
  if (idBacked.length === 0) {
    throw verificationError(
      "target_not_verified",
      "Upriver did not provide a verified channel ID for the legacy YouTube URL"
    );
  }
  return selectOneChannelId(idBacked);
}

function assertDirectResponseMapping(
  requested: YouTubeHandleReference | YouTubeChannelIdReference,
  identity: VerifiedYouTubeIdentity,
  responseRequestedUrl: string | null
): void {
  if (responseRequestedUrl === null) {
    throw verificationError(
      "target_not_verified",
      "Upriver did not return the requested YouTube URL"
    );
  }

  let responseReference: YouTubeChannelReference;
  try {
    responseReference = parseProviderRequestedYouTubeUrl(
      responseRequestedUrl
    );
  } catch {
    throw verificationError(
      "target_not_verified",
      "Upriver returned an invalid requested YouTube URL"
    );
  }
  if (responseReference.requestKey === requested.requestKey) {
    return;
  }
  if (
    responseReference.kind === "channel_id" &&
    identity.channelId === responseReference.channelId
  ) {
    return;
  }
  if (
    responseReference.kind === "handle" &&
    identity.handle !== null &&
    responseReference.requestKey ===
      identityForHandle(identity.handle).requestKey
  ) {
    return;
  }
  throw verificationError(
    "target_identity_mismatch",
    "Upriver returned a different requested YouTube channel"
  );
}

function assertNoConflictingIdForMatchedHandles(
  candidates: VerifiedCandidate[],
  matches: VerifiedCandidate[],
  requestedChannelId: string
): void {
  const matchedHandles = new Set(
    matches.flatMap((candidate) =>
      candidate.handleKey === null ? [] : [candidate.handleKey]
    )
  );
  const conflictingMatch = candidates.some(
    (candidate) =>
      candidate.channelId !== null &&
      candidate.channelId !== requestedChannelId &&
      candidate.handleKey !== null &&
      matchedHandles.has(candidate.handleKey)
  );
  if (conflictingMatch) {
    throw verificationError(
      "target_identity_ambiguous",
      "Upriver mapped the requested YouTube handle to different channel IDs"
    );
  }
}

function selectOneChannelId(
  candidates: VerifiedCandidate[]
): VerifiedYouTubeChannelSelection {
  const byChannelId = new Map<string, VerifiedCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.channelId === null) {
      continue;
    }
    const grouped = byChannelId.get(candidate.channelId) ?? [];
    grouped.push(candidate);
    byChannelId.set(candidate.channelId, grouped);
  }

  if (byChannelId.size !== 1) {
    throw verificationError(
      "target_identity_ambiguous",
      "Upriver returned multiple different YouTube channel IDs"
    );
  }

  const [channelId, duplicates] = [...byChannelId.entries()][0];
  assertConsistentDuplicates(duplicates);
  const representative = chooseRepresentative(duplicates);
  const handle = representative.handle;
  return {
    channel: representative.channel,
    identity: {
      verificationBasis: "channel_id",
      channelId,
      handle,
      canonicalUrl:
        handle === null
          ? channelIdReference(channelId).lookupUrl
          : identityForHandle(handle).lookupUrl,
      key: `channel:${channelId}`
    }
  };
}

function assertConsistentDuplicates(
  candidates: VerifiedCandidate[]
): void {
  const handles = new Set(
    candidates.flatMap((candidate) =>
      candidate.handleKey === null ? [] : [candidate.handleKey]
    )
  );
  const subscriberCounts = new Set(
    candidates.flatMap((candidate) =>
      candidate.channel.subscriberCount === null
        ? []
        : [candidate.channel.subscriberCount]
    )
  );
  const displayNames = new Set(
    candidates.flatMap((candidate) => {
      const displayName = candidate.channel.displayName.trim();
      return displayName ? [displayName] : [];
    })
  );
  if (
    handles.size > 1 ||
    subscriberCounts.size > 1 ||
    displayNames.size > 1
  ) {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned conflicting duplicate YouTube channel evidence"
    );
  }
}

function chooseRepresentative(
  candidates: VerifiedCandidate[]
): VerifiedCandidate {
  return [...candidates].sort((first, second) => {
    const scoreDifference =
      candidateCompleteness(second) - candidateCompleteness(first);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    return first.urlReference.lookupUrl.localeCompare(
      second.urlReference.lookupUrl
    );
  })[0];
}

function candidateCompleteness(candidate: VerifiedCandidate): number {
  return (
    (candidate.urlReference.kind === "handle" ? 4 : 0) +
    (candidate.handle === null ? 0 : 2) +
    (candidate.channel.subscriberCount === null ? 0 : 1)
  );
}

function parseDeclaredHandle(
  handle: string
): YouTubeHandleReference | null {
  const value = handle.trim();
  if (!value) {
    return null;
  }

  try {
    return identityForHandle(
      value.startsWith("@") ? value.slice(1) : value
    );
  } catch {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned an invalid YouTube handle"
    );
  }
}

function parseProviderCanonicalChannelUrl(
  url: string
): YouTubeHandleReference | YouTubeChannelIdReference {
  const reference = parseProviderRequestedYouTubeUrl(url);
  if (
    reference.kind !== "handle" &&
    reference.kind !== "channel_id"
  ) {
    throw new Error("Provider channel evidence is not canonical");
  }
  return reference;
}

function parseProviderRequestedYouTubeUrl(
  url: string
): YouTubeChannelReference {
  const value = url.trim();
  if (!HTTP_ABSOLUTE_URL_PATTERN.test(value)) {
    throw new Error("Provider channel evidence is not an absolute URL");
  }
  return parseYouTubeChannelReference(value);
}

function parsePlatformId(
  platformId: string | null | undefined
): string | null {
  if (platformId === null || platformId === undefined) {
    return null;
  }
  const value = platformId.trim();
  if (!value) {
    return null;
  }
  if (!YOUTUBE_CHANNEL_ID_PATTERN.test(value)) {
    throw verificationError(
      "target_identity_mismatch",
      "Upriver returned an invalid YouTube channel ID"
    );
  }
  return value;
}

function verificationError(
  code: YouTubeTargetVerificationCode,
  message: string
): YouTubeTargetVerificationError {
  return new YouTubeTargetVerificationError(code, message);
}

function identityForHandle(handle: string): YouTubeHandleReference {
  const normalizedHandle = normalizeIdentifier(handle);
  if (!YOUTUBE_HANDLE_PATTERN.test(normalizedHandle)) {
    throw new Error("YouTube handle contains unsupported characters");
  }

  const requestKey = `handle:${normalizedHandle.toLowerCase()}`;
  const lookupUrl = `https://www.youtube.com/@${normalizedHandle}`;
  return {
    kind: "handle",
    handle: normalizedHandle,
    requestKey,
    lookupUrl,
    key: requestKey,
    canonicalUrl: lookupUrl
  };
}

function channelIdReference(
  channelId: string
): YouTubeChannelIdReference {
  const requestKey = `channel:${channelId}`;
  const lookupUrl = `https://www.youtube.com/channel/${channelId}`;
  return {
    kind: "channel_id",
    channelId,
    requestKey,
    lookupUrl,
    key: requestKey,
    canonicalUrl: lookupUrl
  };
}

function legacyReference(
  kind: "legacy_user" | "legacy_custom",
  slug: string
): YouTubeLegacyUserReference | YouTubeLegacyCustomReference {
  const normalizedSlug = normalizeIdentifier(slug);
  if (!YOUTUBE_HANDLE_PATTERN.test(normalizedSlug)) {
    throw new Error(
      "YouTube legacy channel name contains unsupported characters"
    );
  }

  const pathKind = kind === "legacy_user" ? "user" : "c";
  const requestKey = `${kind}:${normalizedSlug}`;
  const lookupUrl = `https://www.youtube.com/${pathKind}/${normalizedSlug}`;
  return {
    kind,
    slug: normalizedSlug,
    requestKey,
    lookupUrl,
    key: requestKey,
    canonicalUrl: lookupUrl
  };
}

function parseAbsoluteUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Enter a valid YouTube channel URL");
  }
}

function stripOneTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.normalize("NFC");
}

function decodePathSegment(segment: string): string {
  try {
    return normalizeIdentifier(decodeURIComponent(segment));
  } catch {
    throw new Error("YouTube channel URL contains invalid encoding");
  }
}
