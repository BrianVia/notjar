// rrweb event constants we care about (from @rrweb/types).
export const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4, Custom: 5 } as const;
const Source = { MouseInteraction: 2 } as const;
const MouseInteraction = { Click: 2 } as const;

export type RREvent = { type: number; timestamp: number; data?: any };

export type ChunkStats = {
  first: number;
  last: number;
  pages: number;
  clicks: number;
  rageClicks: number;
  errors: number;
};

const RAGE_WINDOW_MS = 1000;
const RAGE_RADIUS_PX = 40;
const RAGE_MIN_CLICKS = 3;

export function isClick(ev: RREvent): boolean {
  return ev.type === EventType.IncrementalSnapshot && ev.data?.source === Source.MouseInteraction && ev.data?.type === MouseInteraction.Click;
}

/** One pass over a chunk: time bounds, pageviews, clicks, rage-click bursts, captured JS errors. */
export function computeStats(events: RREvent[]): ChunkStats {
  const s: ChunkStats = { first: Infinity, last: -Infinity, pages: 0, clicks: 0, rageClicks: 0, errors: 0 };
  let recent: { t: number; x: number; y: number }[] = [];
  let lastRage = -Infinity;

  for (const ev of events) {
    const t = ev.timestamp;
    if (t < s.first) s.first = t;
    if (t > s.last) s.last = t;

    if (ev.type === EventType.Meta) s.pages++;
    else if (ev.type === EventType.Custom && ev.data?.tag === "error") s.errors++;
    else if (isClick(ev)) {
      s.clicks++;
      const x = Number(ev.data.x) || 0;
      const y = Number(ev.data.y) || 0;
      recent = recent.filter((c) => t - c.t <= RAGE_WINDOW_MS);
      recent.push({ t, x, y });
      const near = recent.filter((c) => Math.hypot(c.x - x, c.y - y) <= RAGE_RADIUS_PX);
      if (near.length >= RAGE_MIN_CLICKS && t - lastRage > RAGE_WINDOW_MS) {
        s.rageClicks++;
        lastRage = t;
      }
    }
  }
  return s;
}

export function validEvents(x: unknown): x is RREvent[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.length <= 20000 &&
    x.every((e) => e && typeof e === "object" && typeof (e as RREvent).type === "number" && Number.isFinite((e as RREvent).timestamp))
  );
}
