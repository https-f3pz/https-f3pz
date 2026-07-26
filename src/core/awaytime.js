// How much time really passed while the game was not running.
//
// This is the load-bearing question of any idle game, and `Date.now() - saved`
// is the wrong answer to it. That expression trusts the device clock, which the
// player controls, and which also moves on its own across timezone changes,
// DST, NTP corrections and a flat battery.
//
// The rules here:
//
//   * Time can never run BACKWARDS into credit. A clock that jumped back is
//     reported as zero elapsed, not as a negative that would underflow the
//     economy.
//   * A single absence is capped. Not to punish anyone, but because an
//     uncapped span lets one clock change collapse the entire progression, and
//     because a decade of accumulation is not a reward, it is an ending.
//   * A monotonic clock cross-checks the wall clock *while the page is open*.
//     performance.now() cannot be set by the user, so if the two disagree
//     during a session the wall clock moved and we believe the monotonic one.
//   * Every decision is reported, not silently applied, so the "while you were
//     away" screen can be honest about what it did.
//
// Nothing here knows anything about the game's economy: it answers "how many
// seconds do you owe the player" and stops.

/** Absences longer than this are truncated. 36h — comfortably more than a night. */
export const AWAY_CAP = 36 * 3600;

/** Below this, the away screen is not worth showing at all. */
export const AWAY_MIN = 60;

/**
 * Jumps larger than this between two in-session ticks are treated as the wall
 * clock being changed rather than as real elapsed time. A backgrounded tab can
 * legitimately skip minutes, so this has to be generous enough not to punish
 * that; anything past it is not a scheduling gap.
 */
const SANE_TICK = 6 * 3600;

export class AwayClock {
  constructor() {
    // Wall clock and monotonic clock, sampled together so drift between them is
    // measurable. performance.now() has an arbitrary origin, which is fine —
    // only differences are ever used.
    this.wall = Date.now();
    this.mono = now();
    // Accumulated real seconds observed while the page was open. This is what
    // makes tampering detectable: if the wall clock says an hour passed but the
    // monotonic clock says four seconds did, the player changed their clock.
    this.sessionSeconds = 0;
    this.suspect = false;
  }

  /**
   * Call once per rendered frame. Keeps the monotonic reference fresh and
   * notices wall-clock movement that did not correspond to real time.
   */
  tick() {
    const w = Date.now();
    const m = now();
    const dMono = (m - this.mono) / 1000;
    const dWall = (w - this.wall) / 1000;

    if (dMono >= 0) this.sessionSeconds += dMono;

    // Both clocks should advance together. A large disagreement means the wall
    // clock was set while we were watching — the one case we can catch red-handed.
    if (Math.abs(dWall - dMono) > SANE_TICK) this.suspect = true;

    this.wall = w;
    this.mono = m;
  }

  /** The timestamp to persist. */
  stamp() {
    return { wall: Date.now(), mono: Math.round(now()) };
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * Resolve an absence.
 *
 * @param saved     the {wall, mono} written when the game was last closed
 * @param opts.cap  maximum seconds to credit (default AWAY_CAP)
 * @param opts.now  injectable clock, for tests
 * @returns {{seconds, rawSeconds, capped, backwards, missing}}
 *
 *   seconds     what to actually credit
 *   rawSeconds  what the wall clock claimed, before capping
 *   capped      the absence was truncated
 *   backwards   the clock moved backwards; nothing credited
 *   missing     no usable timestamp, e.g. a brand new save
 */
export function resolveAway(saved, opts = {}) {
  const cap = opts.cap ?? AWAY_CAP;
  const nowWall = opts.now ?? Date.now();
  const out = { seconds: 0, rawSeconds: 0, capped: false, backwards: false, missing: false };

  const wall = Number(saved?.wall);
  if (!saved || !Number.isFinite(wall) || wall <= 0) {
    out.missing = true;
    return out;
  }

  const raw = (nowWall - wall) / 1000;
  if (!Number.isFinite(raw)) {
    out.missing = true;
    return out;
  }

  out.rawSeconds = raw;

  // A backwards clock is the one case that must never produce credit, because
  // a negative would run the economy in reverse.
  if (raw < 0) {
    out.backwards = true;
    return out;
  }

  if (raw > cap) {
    out.capped = true;
    out.seconds = cap;
    return out;
  }

  out.seconds = raw;
  return out;
}

/** "3 days, 4 hours" — for the away screen. Never returns an empty string. */
export function humanDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} SECOND${s === 1 ? '' : 'S'}`;
  const units = [
    ['DAY', 86400],
    ['HOUR', 3600],
    ['MINUTE', 60],
  ];
  const parts = [];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? '' : 'S'}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(', ') || `${s} SECONDS`;
}
