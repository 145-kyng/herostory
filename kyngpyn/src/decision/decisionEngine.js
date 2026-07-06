// Layer 4 — Decision Engine.
// Aggregates council votes into { approved, confidence } and applies hard
// restrictions (daily loss, news windows, DNT zones, sessions, regime).
// Restrictions are absolute: no score, however high, can bypass them.
import { EVENTS } from '../events.js';
import { VOTES } from '../agents/baseAgent.js';
import { activeSessions } from '../scanner/sessions.js';

export class DecisionEngine {
  constructor({ config, bus, logger, calendar, learningEngine }) {
    this.config = config;
    this.bus = bus;
    this.logger = logger;
    this.calendar = calendar;
    this.learningEngine = learningEngine;
    this.doNotTrade = new Set(
      (process.env.DO_NOT_TRADE || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    this.recentDecisions = [];
  }

  setDoNotTrade(symbol, blocked) {
    if (blocked) this.doNotTrade.add(symbol);
    else this.doNotTrade.delete(symbol);
  }

  /**
   * @returns {{approved: boolean, confidence: number, reasons: string[], votes: object[]}}
   */
  decide({ signal, votes, safety, now = new Date() }) {
    const reasons = [];
    const scores = votes.map((v) => v.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);

    // Blend council average with scanner confidence, then let learning nudge
    // within its configured bound (Layer 6 may modify scores, never rules).
    let confidence = Math.round(avgScore * 0.7 + signal.confidence * 0.3);
    if (this.learningEngine && this.config.learning.enabled) {
      const adj = this.learningEngine.confidenceAdjustment(signal);
      confidence = Math.max(0, Math.min(100, confidence + adj));
      if (adj !== 0) reasons.push(`learning adjustment ${adj > 0 ? '+' : ''}${adj}`);
    }

    const approveVotes = votes.filter((v) => v.vote === VOTES.APPROVE).length;
    const vetoed = votes.filter(
      (v) => v.vote === VOTES.REJECT && this.config.decision.vetoAgents.includes(v.agent),
    );

    let approved = true;

    // --- Hard restrictions (each is terminal) ---
    if (safety?.killSwitch) { approved = false; reasons.push('RESTRICTION: kill switch engaged'); }
    if (safety?.paused) { approved = false; reasons.push('RESTRICTION: trading paused'); }
    if (safety?.dailyLossPct >= this.config.risk.dailyMaxLossPct) {
      approved = false;
      reasons.push(`RESTRICTION: daily loss limit (${safety.dailyLossPct.toFixed(2)}% >= ${this.config.risk.dailyMaxLossPct}%)`);
    }
    if (safety?.consecutiveLosses >= this.config.risk.maxConsecutiveLosses) {
      approved = false;
      reasons.push(`RESTRICTION: ${safety.consecutiveLosses} consecutive losses`);
    }
    if (this.doNotTrade.has(signal.symbol)) {
      approved = false; reasons.push(`RESTRICTION: ${signal.symbol} is in the Do-Not-Trade list`);
    }

    // News window.
    if (this.calendar) {
      const highNews = this.calendar
        .eventsNear(signal.symbol, this.config.sessions.newsWindowMinutes, now)
        .filter((e) => e.impact === 'high');
      if (highNews.length) {
        approved = false;
        reasons.push(`RESTRICTION: news window (${highNews[0].title})`);
      }
    }

    // Session restriction.
    const sessions = activeSessions(now);
    if (!sessions.some((s) => this.config.sessions.allowed.includes(s))) {
      approved = false;
      reasons.push(`RESTRICTION: session not allowed (active: ${sessions.join(',') || 'none'})`);
    }

    // Regime restriction: never enter fresh positions into chaos.
    if (signal.regime === 'volatile') {
      approved = false; reasons.push('RESTRICTION: volatile market regime');
    }

    // --- Council thresholds ---
    if (vetoed.length) {
      approved = false;
      reasons.push(`VETO: ${vetoed.map((v) => `${v.agent} — ${v.reason}`).join(' | ')}`);
    }
    if (confidence < this.config.decision.approvalThreshold) {
      approved = false;
      reasons.push(`confidence ${confidence} below threshold ${this.config.decision.approvalThreshold}`);
    }
    if (approveVotes < this.config.decision.minApproveVotes) {
      approved = false;
      reasons.push(`only ${approveVotes}/${votes.length} agents approve (need ${this.config.decision.minApproveVotes})`);
    }

    if (approved) reasons.push('all checks passed');

    const decision = {
      approved,
      confidence,
      avgScore: Math.round(avgScore),
      approveVotes,
      reasons,
      signal,
      votes,
      time: new Date().toISOString(),
    };

    this.recentDecisions.push(decision);
    if (this.recentDecisions.length > 100) this.recentDecisions.shift();
    this.bus.emit(EVENTS.DECISION, decision);
    this.logger.info(
      `Decision ${signal.symbol} ${signal.direction}: ${approved ? 'APPROVED' : 'rejected'} (confidence ${confidence})`,
      { reasons },
    );
    return decision;
  }
}
