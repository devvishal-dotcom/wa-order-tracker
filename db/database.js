const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', process.env.DB_PATH || 'orders.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();

  // Load existing DB from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Save DB to disk helper
  global._saveDB = () => {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  };

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    TEXT NOT NULL,
      phone       TEXT NOT NULL,
      tracking_link TEXT NOT NULL,
      custom_msg  TEXT,
      status      TEXT DEFAULT 'pending',
      wa_message_id TEXT,
      retries     INTEGER DEFAULT 0,
      error_msg   TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_message_id TEXT,
      event_type  TEXT,
      payload     TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  `);

  global._saveDB();
  console.log('✓ Database initialized at', DB_PATH);
  return db;
}

// ─── Helpers ────────────────────────────────────────────────

function runQuery(sql, params = []) {
  db.run(sql, params);
  global._saveDB();
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getLastInsertId() {
  return getOne('SELECT last_insert_rowid() as id').id;
}

// ─── Order Queries ──────────────────────────────────────────

function createOrder({ order_id, phone, tracking_link, custom_msg }) {
  runQuery(
    `INSERT INTO orders (order_id, phone, tracking_link, custom_msg) VALUES (?, ?, ?, ?)`,
    [order_id, phone, tracking_link, custom_msg || null]
  );
  const id = getLastInsertId();
  return getOrderById(id);
}

function updateOrderStatus(id, { status, wa_message_id, error_msg, retries }) {
  runQuery(
    `UPDATE orders SET
      status = COALESCE(?, status),
      wa_message_id = COALESCE(?, wa_message_id),
      error_msg = COALESCE(?, error_msg),
      retries = COALESCE(?, retries),
      updated_at = datetime('now')
     WHERE id = ?`,
    [status || null, wa_message_id || null, error_msg || null, retries ?? null, id]
  );
  return getOrderById(id);
}

function updateStatusByWAMessageId(wa_message_id, status) {
  runQuery(
    `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE wa_message_id = ?`,
    [status, wa_message_id]
  );
}

function getOrderById(id) {
  return getOne('SELECT * FROM orders WHERE id = ?', [id]);
}

function getAllOrders({ limit = 100, offset = 0, status, search } = {}) {
  let query = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (search) { query += ' AND (order_id LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getAll(query, params);
}

function getStats() {
  return {
    total:     getOne("SELECT COUNT(*) as c FROM orders").c,
    sent:      getOne("SELECT COUNT(*) as c FROM orders WHERE status = 'sent'").c,
    delivered: getOne("SELECT COUNT(*) as c FROM orders WHERE status = 'delivered'").c,
    read:      getOne("SELECT COUNT(*) as c FROM orders WHERE status = 'read'").c,
    failed:    getOne("SELECT COUNT(*) as c FROM orders WHERE status = 'failed'").c,
    today:     getOne("SELECT COUNT(*) as c FROM orders WHERE date(created_at) = date('now')").c,
  };
}

function deleteOrder(id) {
  const before = getOne('SELECT id FROM orders WHERE id = ?', [id]);
  if (!before) return { changes: 0 };
  runQuery('DELETE FROM orders WHERE id = ?', [id]);
  return { changes: 1 };
}

function saveWebhookEvent({ wa_message_id, event_type, payload }) {
  runQuery(
    `INSERT INTO webhook_events (wa_message_id, event_type, payload) VALUES (?, ?, ?)`,
    [wa_message_id, event_type, JSON.stringify(payload)]
  );
}

module.exports = {
  initDB, createOrder, updateOrderStatus, updateStatusByWAMessageId,
  getOrderById, getAllOrders, getStats, deleteOrder, saveWebhookEvent
};
