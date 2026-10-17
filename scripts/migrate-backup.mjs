import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const [inputArg, outputArg, auditArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !auditArg) {
  console.error('Usage: node scripts/migrate-backup.mjs <input.json> <output.json> <audit.json>');
  process.exitCode = 1;
} else {
  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  const auditPath = resolve(auditArg);
  if (inputPath === outputPath) throw new Error('The migration will not overwrite its input file.');

  const sourceText = await readFile(inputPath, 'utf8');
  const source = JSON.parse(sourceText);
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { migrateQuartzBackup } = await server.ssrLoadModule(
      '/src/domain/backupMigration.ts',
    );
    const { loadBundledTimetables } = await server.ssrLoadModule(
      '/src/infrastructure/timetableAssets.ts',
    );
    const result = migrateQuartzBackup(source, loadBundledTimetables(), new Date());
    const outputText = `${JSON.stringify(result.document, null, 2)}\n`;
    const audit = {
      ...result.audit,
      sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
      migratedSha256: createHash('sha256').update(outputText).digest('hex'),
      sourceFile: inputPath,
      migratedFile: outputPath,
    };
    await writeFile(outputPath, outputText, { flag: 'wx' });
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(audit, null, 2));
  } finally {
    await server.close();
  }
}
