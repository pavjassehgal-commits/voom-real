import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// What a screen shows or does, without the comments that explain what it leaves out.
const code = async (path) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("Calendar opens on Month, offers Week, and both read the one real workflow feed", async () => {
  const page = await code("app/app/(shell)/calendar/page.tsx");
  assert.match(page, /useState<CalendarMode>\("month"\)/, "Month is the default view");
  assert.match(page, /\(\["week", "month"\] as const\)/, "Week and Month are the only views offered");
  assert.match(page, /fetch\("\/api\/voom\/workflow"/);
  assert.match(page, /<WeekView/);
  assert.match(page, /onOpen=\{\(event\) => openEvent\(event, open, load\)\}/, "week cards open the same editors as the month view");
  for (const editor of ["SocialEditorModal", "SavedCalendarDetailModal", "CreateContentModal"]) assert.match(page, new RegExp(editor));
  assert.match(page, /const DOW = \["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"\]/, "weeks start on Monday, as in the reference");
  assert.doesNotMatch(page, /Best time|>List<|All channels|Ask MARA/, "no invented best-time, list view, channel menu or chat");
  assert.doesNotMatch(page, /\.(insert|update|upsert|delete)\(/, "the calendar only reads; edits stay in the existing modals");
});

test("Contacts keeps the existing actions and filters only on real fields", async () => {
  const workspace = await code("components/voom/contacts/ContactsWorkspace.tsx");
  for (const modal of ["ContactEditorModal", "CsvImportModal", "AudienceEditorModal"]) assert.match(workspace, new RegExp(modal));
  assert.match(workspace, /c\.email_status === "subscribed"/, "consent filters read the stored status");
  assert.match(workspace, /b\.created_at\.localeCompare\(a\.created_at\)/, "sorting uses the real created date");
  assert.match(workspace, /PAGE_SIZE = 25/);
  assert.doesNotMatch(workspace, /type="checkbox"|Select all|Export CSV|Export contacts|Segment|More filters|Get suggestions|vs last month/, "no bulk actions, segments, exports or invented trends");
  assert.doesNotMatch(workspace, /resend|clicksend|sendEmail|sendSms/i, "no email is sent from this screen");
});
