// Keep historical fixture relationships while avoiding wall-clock expiry in
// SQL guards that intentionally compare against PostgreSQL now(). This shifts
// test INPUTS only; production clocks/guards are not mocked or weakened.
const DAY = 86_400_000;
const SHIFT = Math.max(0, Math.ceil((Date.now() - Date.parse("2026-09-20T12:00:00Z")) / DAY) + 2) * DAY;
export function futureCampaignFixture(value) {
  const shifted = new Date(Date.parse(value) + SHIFT).toISOString();
  return value.length === 10 ? shifted.slice(0, 10) : shifted;
}
