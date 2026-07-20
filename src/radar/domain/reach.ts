export interface ReachWindow {
  minimumRatio: number;
  maximumRatio: number;
}

export const DEFAULT_REACH_WINDOW: ReachWindow = {
  minimumRatio: 0.75,
  maximumRatio: 1.25
};

export function reachRatio(
  targetSubscribers: number,
  peerSubscribers: number
): number | null {
  if (
    !Number.isFinite(targetSubscribers) ||
    !Number.isFinite(peerSubscribers) ||
    targetSubscribers <= 0 ||
    peerSubscribers < 0
  ) {
    return null;
  }

  return peerSubscribers / targetSubscribers;
}

export function isReachComparable(
  targetSubscribers: number,
  peerSubscribers: number,
  window = DEFAULT_REACH_WINDOW
): boolean {
  const ratio = reachRatio(targetSubscribers, peerSubscribers);
  return (
    ratio !== null &&
    ratio >= window.minimumRatio &&
    ratio <= window.maximumRatio
  );
}
