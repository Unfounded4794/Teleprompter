const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function brakingDistance(progress) {
  return progress - progress ** 3 + .5 * progress ** 4;
}

export class VoiceScroll {
  reset() {
    this.position = undefined;
  }

  reframe(position, match, now) {
    this.position = position;
    this.match = this.samplePosition = match;
    this.sampleTime = now;
  }

  update(match, first, last, lineHeight, speaking, now, smoothing = 60) {
    if (this.position === undefined) {
      this.position = this.match = this.samplePosition = match;
      this.sampleTime = this.updatedAt = now;
      this.velocity = 0;
      this.pace = lineHeight * .55;
      this.rewinding = false;
      this.brake = null;
    }

    if (match !== this.match) {
      const change = match - this.match;
      const elapsed = (now - this.sampleTime) / 1000;
      if (change < -1 || change > lineHeight * 2.5 || elapsed >= 2.2) {
        this.rewinding = change < -1;
        this.samplePosition = match;
        this.sampleTime = now;
      } else if (elapsed >= .42) {
        if (speaking) {
          const measured = clamp((match - this.samplePosition) / elapsed, lineHeight * .18, lineHeight * 2.3);
          this.pace += (measured - this.pace) * .24;
        }
        this.samplePosition = match;
        this.sampleTime = now;
      }
      this.match = match;
    }

    const elapsed = clamp((now - this.updatedAt) / 1000, 0, .05);
    this.updatedAt = now;
    let distance;
    if (!speaking) {
      this.brake ??= { velocity: this.velocity, progress: 0, duration: .23 + smoothing * .0095 };
      const previous = this.brake.progress;
      const progress = Math.min(1, previous + elapsed / this.brake.duration);
      this.brake.progress = progress;
      this.velocity = this.brake.velocity * (1 - progress ** 2 * (3 - 2 * progress));
      distance = this.brake.velocity * this.brake.duration * (brakingDistance(progress) - brakingDistance(previous));
    } else {
      this.brake = null;
      const gain = this.requestedSpeed(match, first, last, lineHeight);
      // Keep a running pixel speed like Timed mode. Matches only change the
      // speed estimate and the gradual correction back to the reading line.
      const response = .08 + smoothing * .0034;
      const blend = -Math.expm1(-elapsed / response);
      const error = this.velocity - gain;
      distance = gain * elapsed + error * response * blend;
      this.velocity -= error * blend;
    }

    const next = this.position + distance;
    this.position = clamp(next, first, last);
    if (this.position !== next) this.velocity = 0;
    return this.position;
  }

  requestedSpeed(match, first, last, lineHeight) {
    const error = match - this.position;
    if (error >= -2) this.rewinding = false;
    if (this.rewinding) return Math.max(error * 1.5, -lineHeight * 3, (first - this.position) * 2.6);

    // Ease off the pace when there is no fresh match, leaving room to coast
    // over a quiet syllable or a late decoding result without hitting a wall.
    const reserve = clamp((lineHeight * 1.3 + error) / (lineHeight * .8), 0, 1);
    const speed = (this.pace + clamp(error * 1.15, -this.pace * .5, lineHeight * 1.25)) * reserve;
    return Math.min(speed, lineHeight * 3, (last - this.position) * 2.6);
  }
}
