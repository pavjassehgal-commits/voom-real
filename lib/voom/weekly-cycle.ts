export function dubaiWeek(now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - daysSinceMonday);
  const weekKey = utc.toISOString().slice(0, 10);
  return { weekKey, cycleStartIso: `${weekKey}T00:00:00+04:00` };
}
