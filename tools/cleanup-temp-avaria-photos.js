import { pool, tx } from "../server/db.js";
import { getStorageService } from "../server/services/storage/storage.service.js";

const apply = process.argv.includes("--apply");
const deleteFiles = process.argv.includes("--delete-files");
const batchSize = Number(process.env.CLEANUP_AVARIA_PHOTOS_BATCH || 100);

const summary = {
  dryRun: !apply,
  deleteFiles,
  analyzed: 0,
  markedDeleted: 0,
  filesDeleted: 0,
  fileDeleteFailures: 0
};

try {
  const storage = getStorageService();
  await tx(async (client) => {
    const result = await client.query(
      `SELECT id, storage_key
       FROM devolucao_avaria_fotos
       WHERE item_id IS NULL
         AND deleted_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at < CURRENT_TIMESTAMP
       ORDER BY expires_at
       LIMIT $1
       FOR UPDATE`,
      [batchSize]
    );

    summary.analyzed = result.rows.length;
    if (!apply || !result.rows.length) return;

    const ids = result.rows.map((row) => row.id);
    await client.query(
      `UPDATE devolucao_avaria_fotos
       SET deleted_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    summary.markedDeleted = ids.length;

    if (!deleteFiles) return;
    for (const row of result.rows) {
      try {
        await storage.deleteFile(row.storage_key);
        summary.filesDeleted += 1;
      } catch {
        summary.fileDeleteFailures += 1;
      }
    }
  });

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ...summary, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
