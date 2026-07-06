// Layer 3 — Agent Council. Convenes all six agents on a signal and collects
// their votes. Agents run in parallel; a crashing agent becomes a REJECT so
// failures are always fail-safe.
import { EVENTS } from '../events.js';
import { MarketAgent } from './marketAgent.js';
import { LiquidityAgent } from './liquidityAgent.js';
import { RiskAgent } from './riskAgent.js';
import { NewsAgent } from './newsAgent.js';
import { PortfolioAgent } from './portfolioAgent.js';
import { LearningAgent } from './learningAgent.js';

export class AgentCouncil {
  constructor({ config, bus, logger, marketData, calendar, learningEngine }) {
    this.bus = bus;
    this.logger = logger;
    this.agents = [
      new MarketAgent(),
      new LiquidityAgent({ marketData }),
      new RiskAgent({ config }),
      new NewsAgent({ config, calendar }),
      new PortfolioAgent(),
      new LearningAgent({ config, learningEngine }),
    ];
  }

  async convene(ctx) {
    const votes = await Promise.all(this.agents.map(async (agent) => {
      try {
        return await agent.evaluate(ctx);
      } catch (err) {
        this.logger.error(`${agent.name} crashed: ${err.message}`);
        return { agent: agent.name, vote: 'REJECT', score: 0, reason: `Agent error: ${err.message}` };
      }
    }));
    this.bus.emit(EVENTS.COUNCIL_VOTES, { signal: ctx.signal, votes });
    return votes;
  }
}
