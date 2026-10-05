/**
 * Which entry of the settings index is lit (D-084): the section whose
 * heading is nearest the top of the zone that scrolls, under any fixed
 * header. Pure: the page measures, this decides.
 */
export interface HeadingPosition {
  id: string;
  /** Distance of the heading from the top of the viewport, in pixels. */
  top: number;
}

export interface IndexView {
  /** In page order. */
  headings: readonly HeadingPosition[];
  /** Top of the zone that scrolls, below the fixed header, from the top of the viewport. */
  zoneTop: number;
  /** Bottom of the zone that scrolls. */
  zoneBottom: number;
  /**
   * The entry the user clicked last, until they scroll by hand: the last
   * sections are too short to reach the top, and the click must still light
   * the one asked for while it is in view.
   */
  pinned?: string | undefined;
}

/**
 * How far below the top a heading still counts as at the top: a card
 * brought into view stops 16 px below it (scroll-mt-4), and rounding of
 * smooth scrolling leaves a pixel or two.
 */
export const TOP_SLACK = 24;

export function activeSection(view: IndexView): string | undefined {
  const { headings, zoneTop, zoneBottom, pinned } = view;
  if (pinned !== undefined) {
    const heading = headings.find((item) => item.id === pinned);
    if (heading !== undefined && heading.top >= zoneTop - TOP_SLACK && heading.top < zoneBottom) return pinned;
  }
  // The last heading at or above the top line owns the top of the zone; before the first one, the first.
  let active: string | undefined = headings[0]?.id;
  for (const heading of headings) {
    if (heading.top <= zoneTop + TOP_SLACK) active = heading.id;
    else break;
  }
  return active;
}
