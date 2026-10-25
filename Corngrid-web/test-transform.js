// test-transform.js - Verify the PostgreSQL transform produces valid SQL
const sql = 'DELETE FROM mt5_positions WHERE account_id = ? AND ticket NOT IN (SELECT value FROM json_each(?))';

let s = sql.trim();

// Apply the same transforms as in db-postgres.js
s = s.replace(/SELECT\s+value\s+FROM\s+json_each\(\s*\?\s*\)/gi,
              'SELECT * FROM json_array_elements_text(CAST(? AS JSON))');
s = s.replace(/json_each\(\s*\?\s*\)/g, 'json_array_elements_text(CAST(? AS JSON))');

// Simulate convertPlaceholders
function convertPlaceholders(sql) {
    let out = ''; let i = 0; let inSingle = false;
    for (let idx = 0; idx < sql.length; idx++) {
        const ch = sql[idx];
        if (ch === "'") { inSingle = !inSingle; out += ch; continue; }
        if (!inSingle && ch === '?') { i += 1; out += '$' + i; continue; }
        out += ch;
    }
    return out;
}

const finalSql = convertPlaceholders(s);
console.log('Original SQL:');
console.log(sql);
console.log('\nTransformed SQL:');
console.log(finalSql);
console.log('\nParams: [accountId, ["TICKET1","TICKET2"]]');