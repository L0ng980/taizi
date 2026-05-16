const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'tiger.db');

let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_PATH)) {
    const buf = fs.readFileSync(DATA_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance REAL DEFAULT 20,
      profit REAL DEFAULT 0,
      payout_rate REAL DEFAULT 0.80,
      is_admin INTEGER DEFAULT 0,
      admin_set_rate INTEGER DEFAULT 0,
      custom_payout_rate REAL,
      recent_games TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bet_amount REAL NOT NULL,
      win_amount REAL DEFAULT 0,
      cost REAL NOT NULL,
      roll_count INTEGER DEFAULT 1,
      results TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  saveDb();
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DATA_PATH, Buffer.from(data));
}

function dbGet(sql, params) {
  var stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  if (stmt.step()) { var r = stmt.getAsObject(); stmt.free(); return r; }
  stmt.free();
  return null;
}

function dbAll(sql, params) {
  var stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  var results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function dbRun(sql, params) {
  db.run(sql, params || []);
}

function dbRunInsert(sql, params) {
  db.run(sql, params || []);
  var r = db.exec('SELECT last_insert_rowid() as id');
  return r[0].values[0][0];
}

function getDb() { return db; }

module.exports = { initDb, getDb, saveDb, dbGet, dbAll, dbRun, dbRunInsert };
