const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const DATABASE_URL = process.env.DATABASE_URL;

async function checkPostgres(dbUrl) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const tablesRes = await pool.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY name");
    console.log("tables:", tablesRes.rows.map(x => x.name).join(", "));
    const usersRes = await pool.query("SELECT username, email, created_at FROM users ORDER BY created_at DESC LIMIT 15");
    console.log("users listed:", usersRes.rowCount);
    usersRes.rows.forEach(x => console.log("  " + x.username + " | " + x.email + " | " + x.created_at));
    const countRes = await pool.query("SELECT COUNT(*) AS c FROM users");
    console.log("TOTAL users:", countRes.rows[0] ? countRes.rows[0].c : "?");
    const tests = usersRes.rows.filter(x => /^(ui|test|uia|uib|uic|uid|uif|uit)/i.test(x.username) || /corngrid\.test$/i.test(x.email));
    console.log("SUSPECT test accounts in list:", tests.length);
    tests.forEach(x => console.log("   TEST> " + x.username + " | " + x.email));
  } catch (e) {
    console.log("ERR", e.message);
  } finally {
    await pool.end();
  }
}

async function checkSqlite(dbPath) {
  const sqlite3 = require("sqlite3").verbose();
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) { console.log("OPEN ERR", err.message); process.exit(1); }
  });
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, t) => {
    if (e) { console.log("TABLE ERR", e.message); process.exit(1); }
    console.log("tables:", t.map(x => x.name).join(", "));
    db.all("SELECT username, email, created_at FROM users ORDER BY created_at DESC LIMIT 15", (e2, r) => {
      if (e2) { console.log("USERS ERR", e2.message); process.exit(1); }
      console.log("users listed:", r.length);
      r.forEach(x => console.log("  " + x.username + " | " + x.email + " | " + x.created_at));
      db.get("SELECT COUNT(*) AS c FROM users", (e3, g) => {
        console.log("TOTAL users:", g ? g.c : "?");
        const tests = r.filter(x => /^(ui|test|uia|uib|uic|uid|uif|uit)/i.test(x.username) || /corngrid\.test$/i.test(x.email));
        console.log("SUSPECT test accounts in list:", tests.length);
        tests.forEach(x => console.log("   TEST> " + x.username + " | " + x.email));
        db.close();
      });
    });
  });
}

if (DATABASE_URL) {
  checkPostgres(DATABASE_URL);
} else {
  checkSqlite(path.join(__dirname, "database.sqlite"));
}
