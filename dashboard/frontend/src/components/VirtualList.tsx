import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { cutShort, edgeSide, offsetsOf, visibleRange, type EdgeSide } from "../virtual";
import { LIVE_EDGE_PX } from "./ScrollTop";

/** A screen past each edge is drawn, so a fast scroll does not show blank space. */
const OVERSCAN_SCREENS = 1;

/** More is asked for while two screens are still left below. */
const NEAR_END_SCREENS = 2;

interface Viewport {
  top: number;
  height: number;
}

/**
 * Draws only the items near the scroller's view, each measured once drawn; the rest are estimated
 * from items of the same size class. The first item in view holds its place when items above it
 * arrive or change height, unless the list is at its top.
 */
export function VirtualList({
  keys,
  sizeClass,
  fallback,
  render,
  scroller,
  onNearEnd,
  onNearStart,
  follow = true,
  reveal,
  revealGap = 0,
  marker,
  onMarker,
}: {
  keys: readonly number[];
  sizeClass: (key: number) => number;
  /** The height guessed before anything has been measured. */
  fallback: number;
  render: (key: number) => ReactNode;
  scroller: RefObject<HTMLElement | null>;
  onNearEnd?: () => void;
  /** Asked when two screens are left above, for a list that loads upward too. */
  onNearStart?: () => void;
  /** Off where the list's top is not the newest item: the first item in view then holds its place
   *  there too, as items load above it. */
  follow?: boolean;
  /** Brought to the top of the view once, when it first appears among the keys. */
  reveal?: number | null;
  /** Left above a revealed item, for whatever floats over the list's top. */
  revealGap?: number;
  /** Held in preference to the first item in view while within the live edge's reach of the top, so
   *  it stays put as items move from one side of it to the other. */
  marker?: number;
  /** Told whenever the marker moves to another side of the view. */
  onMarker?: (side: EdgeSide) => void;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  // Each drawn item's height and the size class it was measured in.
  const measured = useRef(new Map<number, { height: number; size: number }>());
  const classes = useRef(new Map<number, { sum: number; count: number }>());
  const sizeOf = useRef(sizeClass);
  useLayoutEffect(() => {
    sizeOf.current = sizeClass;
  });
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 0 });
  const readViewport = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { scrollTop: top, clientHeight: height } = element;
    setViewport((was) => (was.top === top && was.height === height ? was : { top, height }));
  }, [scroller]);

  // Measurements arrive in bursts; one recount per frame covers them.
  const pending = useRef<number | null>(null);
  const bump = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = null;
      setRevision((was) => was + 1);
    });
  }, []);
  useEffect(() => () => {
    if (pending.current !== null) cancelAnimationFrame(pending.current);
  }, []);

  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const key = Number((entry.target as HTMLElement).dataset.key);
          const height = entry.borderBoxSize[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
          if (!Number.isFinite(key) || height <= 0) continue;
          const was = measured.current.get(key);
          if (was !== undefined && Math.abs(was.height - height) < 0.5) continue;
          if (was !== undefined) {
            const old = classes.current.get(was.size);
            if (old) classes.current.set(was.size, { sum: old.sum - was.height, count: old.count - 1 });
          }
          const size = sizeOf.current(key);
          const into = classes.current.get(size) ?? { sum: 0, count: 0 };
          classes.current.set(size, { sum: into.sum + height, count: into.count + 1 });
          measured.current.set(key, { height, size });
          changed = true;
        }
        if (changed) bump();
      }),
  );
  useEffect(() => () => observer.disconnect(), [observer]);

  // Follows the scroller, and forgets every height when its width changes, since cards reflow.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame: number | null = null;
    let width = element.clientWidth;
    const follow = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        readViewport();
      });
    };
    const resized = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        measured.current.clear();
        classes.current.clear();
        // The drawn items have already reported their new heights, which were just forgotten; a
        // fresh observation reports them again.
        for (const item of container.current?.children ?? []) {
          observer.unobserve(item);
          observer.observe(item);
        }
        bump();
      }
      follow();
    });
    element.addEventListener("scroll", follow, { passive: true });
    resized.observe(element);
    follow();
    return () => {
      element.removeEventListener("scroll", follow);
      resized.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scroller, bump, observer, readViewport]);

  const estimate = useCallback(
    (key: number) => {
      const size = classes.current.get(sizeClass(key));
      return size && size.count > 0 ? size.sum / size.count : fallback;
    },
    [sizeClass, fallback],
  );

  const offsets = useMemo(
    () => offsetsOf(keys.map((key) => measured.current.get(key)?.height ?? estimate(key))),
    // `revision` stands for the measurements, which live in a ref.
    [keys, estimate, revision],
  );

  // The list's own top within the scroller, below whatever sits above it.
  const start = container.current?.offsetTop ?? 0;
  const [first, last] = visibleRange(
    offsets,
    viewport.top - start,
    viewport.height,
    viewport.height * OVERSCAN_SCREENS,
  );
  const total = offsets[keys.length] ?? 0;
  const markerAt = marker === undefined ? -1 : keys.indexOf(marker);
  // A screen below the marker, so it can reach the top while what is below it still loads; else the
  // browser cuts the scroll short, which reads as the reader moving.
  const height = Math.max(total, markerAt < 0 ? 0 : (offsets[markerAt] ?? 0) + (scroller.current?.clientHeight ?? 0));

  // Holds the first item in view where the reader left it, when the list is away from its top. The
  // place is kept exact and each correction aimed at it, so the browser's rounding of `scrollTop`
  // cannot add up; it is taken again only when the reader scrolls.
  const anchor = useRef<{ key: number; place: number } | null>(null);
  const settled = useRef<number | null>(null);

  // Before the anchor below, which then holds the revealed item itself, as those above it, placed
  // by estimate, are measured.
  const revealed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || reveal === undefined) return;
    const index = reveal === null ? -1 : keys.indexOf(reveal);
    const offset = offsets[index];
    // Let go once it is gone, so a list read again lands again.
    if (reveal === null || index < 0 || offset === undefined) {
      revealed.current = null;
      return;
    }
    if (revealed.current === reveal) return;
    revealed.current = reveal;
    // Read afresh here and below: what sits above the list may have changed in this very commit.
    element.scrollTop = (container.current?.offsetTop ?? 0) + offset - revealGap;
    // The place meant, not the one reached: a list still too short to scroll that far is taken there
    // as it grows.
    anchor.current = { key: reveal, place: revealGap };
    settled.current = element.scrollTop;
    readViewport();
  });

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const start = container.current?.offsetTop ?? 0;
    const held = anchor.current;
    const current = element.scrollTop;
    // The browser cutting the scroll short as the list shrank is not the reader moving.
    const clamped = cutShort(current, settled.current, element.scrollHeight, element.clientHeight);
    const moved = settled.current === null ? null : clamped ? 0 : current - settled.current;
    const index = held && (current > LIVE_EDGE_PX || !follow) ? keys.indexOf(held.key) : -1;
    const offset = offsets[index];
    if (held && moved !== null && offset !== undefined) {
      // What the reader scrolled is kept; what arrived or grew above is taken back out.
      const target = start + offset - held.place + moved;
      if (Math.abs(current - target) >= 0.5) {
        element.scrollTop = target;
        // Before the paint, or it shows the items drawn for the old place.
        readViewport();
      }
    }
    if (!held || moved !== 0 || offset === undefined) {
      const markerPlace = start + (offsets[markerAt] ?? 0) - element.scrollTop;
      const [inView] =
        markerAt >= 0 && Math.abs(markerPlace) <= LIVE_EDGE_PX
          ? [markerAt]
          : visibleRange(offsets, element.scrollTop - start, 0, 0);
      const key = keys[inView];
      anchor.current = key === undefined ? null : { key, place: start + (offsets[inView] ?? 0) - element.scrollTop };
    }
    settled.current = element.scrollTop;
  });

  const side = useRef<EdgeSide | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const top = offsets[markerAt];
    const bottom = offsets[markerAt + 1];
    if (!element || !onMarker || top === undefined || bottom === undefined) return;
    const now = edgeSide(start + top - element.scrollTop, bottom - top, element.clientHeight, LIVE_EDGE_PX);
    if (now === side.current) return;
    side.current = now;
    onMarker(now);
  });

  // Observes what is drawn and lets go of what no longer is.
  const observed = useRef(new Set<Element>());
  useLayoutEffect(() => {
    const drawn = new Set<Element>(container.current ? [...container.current.children] : []);
    for (const element of observed.current) if (!drawn.has(element)) observer.unobserve(element);
    for (const element of drawn) if (!observed.current.has(element)) observer.observe(element);
    observed.current = drawn;
  });

  useEffect(() => {
    if (!onNearEnd || viewport.height === 0) return;
    if (total - (viewport.top - start + viewport.height) < viewport.height * NEAR_END_SCREENS) onNearEnd();
  });

  useEffect(() => {
    if (!onNearStart || viewport.height === 0 || keys.length === 0) return;
    // Read afresh: a reveal moves the scroll a frame before the viewport hears of it.
    const top = scroller.current?.scrollTop ?? viewport.top;
    if (top - start < viewport.height * NEAR_END_SCREENS) onNearStart();
  });

  const items: ReactNode[] = [];
  for (let index = Math.max(0, first); index <= last && index < keys.length; index++) {
    const key = keys[index];
    if (key === undefined) continue;
    items.push(
      <div
        key={key}
        className="virtual-item"
        data-key={key}
        style={{ transform: `translateY(${offsets[index] ?? 0}px)` }}
      >
        {render(key)}
      </div>,
    );
  }

  return (
    <div className="virtual-list" ref={container} style={{ height }}>
      {items}
    </div>
  );
}
