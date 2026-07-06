// News Agent — vetoes entries inside high-impact news windows and trims
// score when medium-impact events are near.
import { BaseAgent, VOTES } from './baseAgent.js';

export class NewsAgent extends BaseAgent {
  constructor({ config, calendar }) {
    super('News Agent');
    this.config = config;
    this.calendar = calendar;
  }

  async evaluate({ signal }) {
    const windowMinutes = this.config.sessions.newsWindowMinutes;
    const near = this.calendar ? this.calendar.eventsNear(signal.symbol, windowMinutes) : [];

    const high = near.filter((e) => e.impact === 'high');
    if (high.length) {
      return this.result(VOTES.REJECT, 5, `High-impact news within ${windowMinutes}m: ${high[0].title} (${high[0].currency}).`);
    }
    const medium = near.filter((e) => e.impact === 'medium');
    if (medium.length) {
      return this.result(VOTES.ABSTAIN, 45, `Medium-impact news nearby: ${medium[0].title}.`);
    }
    return this.result(VOTES.APPROVE, 75, 'No relevant news in window.');
  }
}
