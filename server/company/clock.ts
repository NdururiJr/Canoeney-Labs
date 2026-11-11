// Time-dependent code takes a Clock so tests never depend on real time.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

// A clock that only moves when told to. now() hands out a fresh Date each call
// so a caller mutating it cannot move the clock.
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date | string) {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(t: Date | string): void {
    this.ms = new Date(t).getTime();
  }
}
