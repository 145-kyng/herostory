// Trading session context, in UTC. Sessions overlap intentionally.

export const SESSIONS = [
  { name: 'sydney', startHour: 21, endHour: 6 },
  { name: 'tokyo', startHour: 0, endHour: 9 },
  { name: 'london', startHour: 7, endHour: 16 },
  { name: 'newyork', startHour: 12, endHour: 21 },
];

export function activeSessions(date = new Date()) {
  const h = date.getUTCHours();
  return SESSIONS
    .filter(({ startHour, endHour }) => (
      startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
    ))
    .map((s) => s.name);
}

export function sessionContext(date = new Date()) {
  const active = activeSessions(date);
  return {
    active,
    overlap: active.includes('london') && active.includes('newyork'),
    weekend: [0, 6].includes(date.getUTCDay()),
  };
}
