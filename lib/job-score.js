// Property Job Score — pure scoring helpers shared by server + client.
// Keep weights/thresholds as named constants here so a future settings panel
// can lift them out without UI changes.

export const JOB_SCORE_MIN_LEADS = 5;

export const JOB_SCORE_WEIGHTS = {
  resp: 0.35,
  speed: 0.30,
  callCov: 0.25,
  noteCov: 0.10,
};

export const JOB_SCORE_THRESHOLDS = {
  resp: { greenAtPct: 80, redAtPct: 20 },
  speedBizMins: { greenAtMins: 15, redAtMins: 480 },
  callCov: { greenAtPct: 70, redAtPct: 10 },
  noteCov: { greenAtPct: 80, redAtPct: 20 },
};

const linearUp = (v, lo, hi) => {
  if (v === null || v === undefined) return null;
  if (v >= hi) return 100;
  if (v <= lo) return 0;
  return Math.round(((v - lo) / (hi - lo)) * 100);
};

const linearDown = (v, fastMs, slowMs) => {
  if (v === null || v === undefined) return null;
  if (v <= fastMs) return 100;
  if (v >= slowMs) return 0;
  return Math.round(100 - ((v - fastMs) / (slowMs - fastMs)) * 100);
};

export function scoreResp(pct) {
  return linearUp(pct, JOB_SCORE_THRESHOLDS.resp.redAtPct, JOB_SCORE_THRESHOLDS.resp.greenAtPct);
}
export function scoreSpeed(mins) {
  return linearDown(mins, JOB_SCORE_THRESHOLDS.speedBizMins.greenAtMins, JOB_SCORE_THRESHOLDS.speedBizMins.redAtMins);
}
export function scoreCallCov(pct) {
  return linearUp(pct, JOB_SCORE_THRESHOLDS.callCov.redAtPct, JOB_SCORE_THRESHOLDS.callCov.greenAtPct);
}
export function scoreNoteCov(pct) {
  return linearUp(pct, JOB_SCORE_THRESHOLDS.noteCov.redAtPct, JOB_SCORE_THRESHOLDS.noteCov.greenAtPct);
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// Compute raw sub-signals for one property given an array of lead objects
// (shape: { responded, speedToLeadBizMinutes, callsOutbound, callsLogged, callsLoggedWithNotes }).
export function computePropertyRawSignals(leads) {
  const total = leads.length;
  if (total === 0) {
    return { total: 0, respPct: null, medSpeed: null, callCovPct: null, noteCovPct: null, totalLogged: 0 };
  }

  const responded = leads.filter((l) => l.responded).length;
  const respPct = Math.round((responded / total) * 100);

  const speedSamples = leads
    .map((l) => l.speedToLeadBizMinutes)
    .filter((v) => v !== null && v !== undefined);
  const medSpeed = mean(speedSamples);

  const withCall = leads.filter((l) => (l.callsOutbound || 0) + (l.callsLogged || 0) > 0).length;
  const callCovPct = Math.round((withCall / total) * 100);

  const totalLogged = leads.reduce((s, l) => s + (l.callsLogged || 0), 0);
  const totalLoggedWithNotes = leads.reduce((s, l) => s + (l.callsLoggedWithNotes || 0), 0);
  const noteCovPct = totalLogged > 0 ? Math.round((totalLoggedWithNotes / totalLogged) * 100) : null;

  return { total, respPct, medSpeed, callCovPct, noteCovPct, totalLogged };
}

// Combine raw signals into a single 0..100 Job Score plus sub-scores.
// Returns { jobScore, belowMinLeads, sub: { resp, speed, callCov, noteCov } }.
// Weights re-normalize across present signals (note coverage may be null
// when the property has no logged calls in the window).
export function computeJobScore(raw) {
  const sub = {
    resp: scoreResp(raw.respPct),
    speed: scoreSpeed(raw.medSpeed),
    callCov: scoreCallCov(raw.callCovPct),
    noteCov: scoreNoteCov(raw.noteCovPct),
  };

  const belowMinLeads = raw.total < JOB_SCORE_MIN_LEADS;
  if (belowMinLeads) return { jobScore: null, belowMinLeads: true, sub };

  const W = JOB_SCORE_WEIGHTS;
  const parts = [
    { v: sub.resp, w: W.resp },
    { v: sub.speed, w: W.speed },
    { v: sub.callCov, w: W.callCov },
    { v: sub.noteCov, w: W.noteCov },
  ].filter((p) => p.v !== null);

  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const jobScore =
    wSum > 0 ? Math.round(parts.reduce((s, p) => s + p.v * p.w, 0) / wSum) : null;

  return { jobScore, belowMinLeads: false, sub };
}
