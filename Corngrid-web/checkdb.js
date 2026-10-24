const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./database.sqlite", sqlite3.OPEN_READONLY, (err) => {
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
      // look for my test-account patterns
      const tests = r.filter(x => /^(ui|test|uia|uib|uic|uid|uif|uit)/i.test(x.username) || /corngrid\.test$/i.test(x.email));
      console.log("SUSPECT test accounts in list:", tests.length);
      tests.forEach(x => console.log("   TEST> " + x.username + " | " + x.email));
      db.close();
    });
  });
});
