/**
 * Storage-then-link protocol for Post Studio visuals.
 *
 * Kept free of Next/`server-only` so the production 0021 row shape and the
 * "DB failure cleans up the just-uploaded object" rule can be unit tested
 * without a database.
 */

export class PostAssetPersistError extends Error {
  readonly code: "storage_failure" | "db_failure";
  readonly phase: "upload" | "previous" | "upsert";

  constructor(code: "storage_failure" | "db_failure", phase: "upload" | "previous" | "upsert") {
    super(`${code}:${phase}`);
    this.name = "PostAssetPersistError";
    this.code = code;
    this.phase = phase;
  }
}

/**
 * Upload the bytes, then upsert the metadata row. If the database write fails
 * after a successful upload, the newly uploaded object is removed so it cannot
 * linger as an orphan. Existing objects that already belong to this draft are
 * left in place (the caller deletes the previous path only after a successful
 * replace).
 */
export async function persistUploadedPostAsset<TRow extends object>(input: {
  upload: () => Promise<void>;
  loadPreviousPath: () => Promise<string | null>;
  upsert: (row: TRow) => Promise<void>;
  removeUploaded: () => Promise<void>;
  row: TRow;
}): Promise<{ previousStoragePath: string | null }> {
  try {
    await input.upload();
  } catch {
    throw new PostAssetPersistError("storage_failure", "upload");
  }

  let previousStoragePath: string | null = null;
  try {
    previousStoragePath = await input.loadPreviousPath();
  } catch {
    await input.removeUploaded();
    throw new PostAssetPersistError("db_failure", "previous");
  }

  try {
    await input.upsert(input.row);
  } catch {
    await input.removeUploaded();
    throw new PostAssetPersistError("db_failure", "upsert");
  }

  return { previousStoragePath };
}
