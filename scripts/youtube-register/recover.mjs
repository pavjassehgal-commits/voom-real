/**
 * Operator-only YouTube deletion register recovery. Never scheduled, never on Vercel.
 *
 *   # Register lost/rolled back (e.g. D1 Time Travel): re-send missing records, report conflicts.
 *   node --env-file=.env.register-ops.local scripts/youtube-register/recover.mjs reconcile --approved
 *
 *   # Main Supabase restored: re-apply erasures the register received since the restore point.
 *   # Run BEFORE YouTube publishing/reconcile crons are re-enabled.
 *   node --env-file=.env.register-ops.local scripts/youtube-register/recover.mjs replay \
 *     --restore-point=2026-11-20T03:00:00Z --approved
 *
 * .env.register-ops.local (git-ignored by `.env*`) holds: NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SECRET_KEY, the five YOUTUBE_DELETION_* delivery values and
 * YOUTUBE_DELETION_REPLAY_TOKEN. Prints counts and VOOM event ids only.
 */
import "../../tests/helpers/server-only-shim.mjs";

const [mode, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
if (!["reconcile", "replay"].includes(mode) || flag("approved") === undefined) {
  console.error("usage: recover.mjs reconcile|replay [--restore-point=ISO] --approved");
  process.exit(2);
}
const { createAdminClient } = await import("../../utils/supabase/admin.ts");
const register = await import("../../lib/youtube/deletion-register.ts");
const db = createAdminClient();
const reader = register.deletionRegisterReader();

if (mode === "reconcile") {
  console.log(JSON.stringify(await register.reconcileDeletionRegister(db, reader), null, 2));
} else {
  const restorePoint = new Date(flag("restore-point") ?? "");
  if (!Number.isFinite(restorePoint.getTime())) { console.error("--restore-point=ISO is required"); process.exit(2); }
  const { eraseYouTubeData } = await import("../../lib/youtube/privacy.ts");
  console.log(JSON.stringify(await register.replayDeletionRegisterAfterRestore(db, reader, { restorePoint, erase: eraseYouTubeData }), null, 2));
}
