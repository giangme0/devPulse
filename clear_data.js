#!/usr/bin/env node
/**
 * DevPulse AI — clear all database records, preserve schema.
 * Node.js 24+, no npm dependencies. Works in ESM and CommonJS projects.
 *
 * Place this file next to package.json (the project root).
 * Stop DevPulse before running:
 *   systemctl --user stop devpulse.service
 *   node clear_data.js
 *   systemctl --user start devpulse.service
 *
 * Options:
 *   --dry-run          Print table counts without deleting anything.
 *   --db /path/file.db  Explicit database path (relative to current directory).
 *   --help             Print usage.
 *
 * Default DB: <script directory>/data/devpulse.db.
 * Supports DEVPULSE_DATA_DIR and PORT from the environment or root .env.
 * Nonempty OS variables take precedence over .env. Relative data directories
 * resolve from the script directory. Does not import/start the application.
 *
 * Deletes news, summaries/translations stored in DB, read/bookmark state,
 * AI cost history, run history and scheduler metadata. Does not delete
 * settings.json, .env, database tables/indexes, or files outside the database.
 * Resetting scheduler metadata allows a new automatic run after restart.
 * This script does not make a backup and does not prompt for confirmation.
 */
(async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const net = await import('node:net');
  const { parseEnv } = await import('node:util');
  const args = process.argv.slice(2);
  let customDb;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node clear_data.js [--dry-run] [--db /path/devpulse.db]');
      console.log('Dừng DevPulse trước khi chạy. Mặc định xóa toàn bộ bản ghi, giữ schema và file cấu hình.');
      return;
    }
    if (args[i] === '--dry-run') { dryRun = true; continue; }
    if (args[i] === '--db' && args[i + 1] && !args[i + 1].startsWith('--')) {
      customDb = args[++i]; continue;
    }
    throw new Error(`Tham số không hợp lệ: ${args[i]}. Dùng --help để xem cách chạy.`);
  }
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Cần Node.js 24 trở lên.');
  }
  const root = path.dirname(fs.realpathSync(process.argv[1]));
  const envPath = path.join(root, '.env');
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const setting = (name, fallback) => process.env[name]?.trim() || fileEnv[name]?.trim() || fallback;
  const file = customDb
    ? path.resolve(customDb)
    : path.join(path.resolve(root, setting('DEVPULSE_DATA_DIR', './data')), 'devpulse.db');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Không tìm thấy database: ${file}. Không tạo database mới.`);
  }
  const port = Number(setting('PORT', '3000'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT phải là số nguyên từ 1 đến 65535.');
  }
  let guard;
  let db;
  let transaction = false;
  try {
    // Hold the configured local port during deletion, so the usual app instance
    // cannot start during this operation. This is not a substitute for stopping
    // custom workers / instances configured on other ports that use the same DB.
    if (!dryRun) {
      guard = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => {
        guard.once('error', error => reject(new Error(
          error.code === 'EADDRINUSE'
            ? `Cổng ${port} đang được sử dụng. Dừng DevPulse/service trước khi xóa dữ liệu.`
            : `Không khóa được cổng ${port}: ${error.code}`
        )));
        guard.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
    }
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(file, { readOnly: dryRun });
    db.exec('PRAGMA busy_timeout=5000;');
    if (!dryRun) {
      db.exec('PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE;');
      transaction = true;
    } else {
      db.exec('BEGIN;');
      transaction = true;
    }
    // PRAGMA table_list lets SQLite distinguish FTS shadow tables from data
    // tables. Delete the virtual table itself, not its internal shadow tables.
    const tables = db.prepare('PRAGMA table_list').all()
      .filter(t => t.schema === 'main' && ['table', 'virtual'].includes(t.type) && !t.name.startsWith('sqlite_'))
      .map(t => t.name).sort();
    if (!['articles', 'runs', 'ai_calls', 'meta'].every(name => tables.includes(name))) {
      throw new Error('Schema không khớp DevPulse AI. Dừng để tránh xóa nhầm database.');
    }
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    console.log(`Database: ${file}`);
    console.log(dryRun ? 'DRY RUN — không xóa dữ liệu.' : 'Đang xóa toàn bộ bản ghi…');
    const rows = tables.map(name => ({
      table: name,
      records: db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n
    }));
    console.table(rows);
    if (!dryRun) {
      for (const name of tables) db.exec(`DELETE FROM ${quote(name)};`);
      const hasSequence = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get();
      if (hasSequence) {
        const reset = db.prepare('DELETE FROM sqlite_sequence WHERE name=?');
        for (const name of tables) reset.run(name);
      }
      for (const name of tables) {
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n;
        if (remaining !== 0) throw new Error(`Bảng ${name} chưa rỗng; rollback toàn bộ.`);
      }
    }
    db.exec('COMMIT;');
    transaction = false;
    if (dryRun) {
      console.log('Chạy lại không có --dry-run để xóa.');
    } else {
      console.log('Hoàn tất: mọi bảng dữ liệu đã rỗng. Giữ nguyên schema, .env và settings.json.');
      console.log('Đã reset cả lịch sử chi phí và lịch chạy. Khi bật lại app, scheduler có thể thu thập/gọi AI lại.');
    }
  } finally {
    if (db) {
      try { if (transaction) db.exec('ROLLBACK;'); }
      finally { db.close(); }
    }
    if (guard?.listening) await new Promise(resolve => guard.close(resolve));
  }
})().catch(error => {
  console.error(`Lỗi: ${error.message}`);
  process.exitCode = 1;
});
