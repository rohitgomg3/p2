/**
 * PlakshaBudget - Node/Express Backend
 * Supports PostgreSQL (default) or MySQL (set DB_TYPE=mysql)
 *
 * Install:  npm install
 * Run:      node server.js   (or: npm start)
 * Dev mode: npm run dev      (nodemon)
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const { Pool: PgPool } = require("pg");
const mysql      = require("mysql2/promise");
const path       = require("path");
const mailer     = require("./mailer");
const teams      = require("./teams");

const app  = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "plakshabudget_secret_change_in_prod";
const DB_TYPE = (process.env.DB_TYPE || "postgres").toLowerCase();
const isMysql = DB_TYPE === "mysql" || DB_TYPE === "mariadb";

// ── DB Connection ────────────────────────────────────────────────────────────
const pool = isMysql
  ? mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306", 10),
      database: process.env.DB_NAME || "budgetflow",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "",
      waitForConnections: true,
      connectionLimit: 10,
      timezone: "Z",
    })
  : new PgPool({
      host:     process.env.DB_HOST     || "localhost",
      port:     parseInt(process.env.DB_PORT || "5432", 10),
      database: process.env.DB_NAME     || "budgetflow",
      user:     process.env.DB_USER     || "postgres",
      password: process.env.DB_PASS     || "",
      ssl:      process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    });

async function db(sql, params = []) {
  if (isMysql) {
    const query = toMysqlQuery(sql, params);
    const [rows] = await pool.query(query.sql, query.params);
    return Array.isArray(rows) ? rows : [];
  }

  const result = await pool.query(sql, params);
  return result.rows;
}

function toMysqlQuery(sql, params = []) {
  const orderedParams = [];
  const convertedSql = sql.replace(/\$(\d+)/g, (_match, index) => {
    orderedParams.push(params[Number(index) - 1]);
    return "?";
  });
  return { sql: convertedSql, params: orderedParams.length ? orderedParams : params };
}

function upsertUserSql() {
  if (isMysql) {
    return `INSERT INTO users (id, name, email, password_hash, role, dept_ids, approver_assignments)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), email=VALUES(email), password_hash=VALUES(password_hash), role=VALUES(role),
         dept_ids=VALUES(dept_ids), approver_assignments=VALUES(approver_assignments)`;
  }
  return `INSERT INTO users (id, name, email, password_hash, role, dept_ids, approver_assignments)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, email=$3, password_hash=$4, role=$5, dept_ids=$6, approver_assignments=$7`;
}

function upsertDepartmentSql() {
  if (isMysql) {
    return `INSERT INTO departments (id, name, notes, budget, spent, reserved, color, codes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), notes=VALUES(notes), budget=VALUES(budget),
         spent=VALUES(spent), reserved=VALUES(reserved), color=VALUES(color),
         codes=VALUES(codes), updated_at=CURRENT_TIMESTAMP`;
  }
  return `INSERT INTO departments (id, name, notes, budget, spent, reserved, color, codes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, notes=$3, budget=$4, spent=$5, reserved=$6, color=$7, codes=$8,
         updated_at=CURRENT_TIMESTAMP`;
}

function upsertConfigSql() {
  if (isMysql) {
    return `INSERT INTO app_config (config_key, value, updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=CURRENT_TIMESTAMP`;
  }
  return `INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=CURRENT_TIMESTAMP`;
}

// Helper: parse JSON field safely
const j = (v, fallback = []) => {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

// ── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      origin === "null" ||
      allowedOrigins.includes("*") ||
      allowedOrigins.includes(origin) ||
      origin.includes("microsoft") ||
      origin.includes("live.com")
    ) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "50mb" }));  // 50MB for attachments
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// ── Map DB row to frontend shape ─────────────────────────────────────────────
function mapUser(row) {
  return {
    id:                   row.id,
    name:                 row.name,
    email:                row.email || "",
    role:                 row.role,
    deptIds:              j(row.dept_ids, []),
    approverAssignments:  j(row.approver_assignments, []),
  };
}

function mapDept(row) {
  return {
    id:       row.id,
    name:     row.name,
    notes:    row.notes || "",
    budget:   parseFloat(row.budget) || 0,
    spent:    parseFloat(row.spent)  || 0,
    reserved: parseFloat(row.reserved) || 0,
    color:    row.color || "#007878",
    codes:    j(row.codes, []),
  };
}

function mapIndent(row) {
  const attsVal = j(row.attachments, []);
  return {
    id:           row.id,
    deptId:       row.dept_id,
    title:        row.title || "",
    notes:        row.notes || "",
    attachments:  attsVal,
    atts:         attsVal,
    items:        j(row.items, []),
    status:       row.status,
    level:        row.level || 0,
    submittedBy:  row.submitted_by,
    submittedAt:  row.submitted_at,
    history:      j(row.history, []),
    procClosed:   Boolean(row.proc_closed),
    procClosedAt: row.proc_closed_at || null,
    procClosedBy: row.proc_closed_by || null,
    rfqSentAt:    row.rfq_sent_at || null,
    rfqVendors:   j(row.rfq_vendors, []),
    rfqSentBy:    row.rfq_sent_by || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { id, password } = req.body;
    if (!id || !password) return res.status(400).json({ error: "ID and password required" });

    const rows = await db("SELECT * FROM users WHERE id = $1 OR email = $2", [id.trim(), id.trim()]);
    if (!rows.length) return res.status(401).json({ error: "User not found" });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token, user: mapUser(user) });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const rows = await db("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(mapUser(rows[0]));
  } catch (err) {
    console.error("GET /api/auth/me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── MICROSOFT SSO & JIT PROVISIONING ROUTES ───────────────────────────────────

// GET /api/auth/microsoft - Initiates Microsoft SSO or mock redirection
app.get("/api/auth/microsoft", (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const backendUrl = process.env.VITE_API_URL || process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI || `${backendUrl}/api/auth/microsoft/callback`;
  
  if (clientId && clientSecret) {
    // Redirect to real Microsoft Microsoft OAuth page
    const microsoftLoginUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user.read&response_mode=query`;
    return res.redirect(microsoftLoginUrl);
  }
  
  // Render mock SSO page if client ID is not configured
  res.send(`
    <html>
      <head>
        <title>Microsoft Account - Sign In (Simulation)</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f2f2f2; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #fff; padding: 44px; width: 360px; box-shadow: 0 2px 6px rgba(0,0,0,0.2); border: 1px solid #d9d9d9; }
          .logo { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; font-weight: 600; font-size: 20px; color: #737373; }
          .logo-box { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; width: 22px; height: 22px; }
          .logo-box div { width: 10px; height: 10px; }
          h2 { margin: 0 0 16px; font-size: 24px; color: #1b1b1b; font-weight: 600; }
          input { width: 100%; padding: 6px 10px; font-size: 15px; border: 1px solid #666; border-radius: 0; margin-bottom: 16px; box-sizing: border-box; }
          input:focus { outline: none; border-color: #0067b8; }
          .buttons { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
          .btn { padding: 6px 12px; font-size: 15px; border: none; cursor: pointer; text-decoration: none; display: inline-block; box-sizing: border-box; text-align: center; }
          .btn-primary { background: #0067b8; color: #fff; min-width: 100px; }
          .btn-primary:hover { background: #005da6; }
          .btn-secondary { background: #cccccc; color: #1b1b1b; min-width: 100px; }
          .btn-secondary:hover { background: #bbbbbb; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">
            <div class="logo-box">
              <div style="background:#f25022"></div>
              <div style="background:#7fba00"></div>
              <div style="background:#00a4ef"></div>
              <div style="background:#ffb900"></div>
            </div>
            <span>Microsoft</span>
          </div>
          <h2>Sign in</h2>
          <p style="font-size:13px;color:#505050;margin-top:-8px;margin-bottom:20px;">Use your Microsoft Account (SSO Simulation)</p>
          <form action="/api/auth/microsoft/mock-callback" method="POST">
            <input type="text" name="name" placeholder="Full Name (e.g. Rohit Gomgee)" required autofocus />
            <input type="email" name="email" placeholder="Email (e.g. rohit@company.com)" required />
            <div class="buttons">
              <input type="button" class="btn btn-secondary" value="Back" onclick="window.history.back()" style="width:auto;margin:0;" />
              <input type="submit" class="btn btn-primary" value="Sign in" style="width:auto;margin:0;" />
            </div>
          </form>
        </div>
      </body>
    </html>
  `);
});

// POST /api/auth/microsoft/mock-callback - Mock SSO callback JIT provisioning
app.post("/api/auth/microsoft/mock-callback", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).send("Name and Email required");
    
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";
    const trimmedEmail = email.trim().toLowerCase();

    // Enforce email domain restriction
    if (!trimmedEmail.endsWith("@plaksha.edu.in")) {
      return res.redirect(`${frontendUrl}/?error=${encodeURIComponent("Only @plaksha.edu.in email addresses are allowed to create accounts.")}`);
    }

    // Generate user ID from email prefix or name slug
    const id = trimmedEmail.split("@")[0].replace(/[^a-z0-9]+/g, "_");
    
    // Check if user exists
    let userRows = await db("SELECT * FROM users WHERE id = $1 OR email = $2", [id, trimmedEmail]);
    if (!userRows.length) {
      // Do NOT create DB record yet. Generate temporary JIT token
      const tempToken = jwt.sign(
        { id, name: name.trim(), email: trimmedEmail, temp: true },
        JWT_SECRET,
        { expiresIn: "15m" }
      );
      return res.redirect(`${frontendUrl}/?temp_token=${tempToken}`);
    }

    const user = userRows[0];
    // Generate JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    // Redirect to frontend with token
    res.redirect(`${frontendUrl}/?token=${token}`);
  } catch (err) {
    console.error("SSO mock callback error:", err);
    res.status(500).send("SSO mock callback failed");
  }
});

// GET /api/auth/microsoft/callback - Real Microsoft SSO callback JIT provisioning
app.get("/api/auth/microsoft/callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).send("Microsoft login error: " + error);
    if (!code) return res.status(400).send("No authorization code provided");

    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    const backendUrl = process.env.VITE_API_URL || process.env.BACKEND_URL || `http://localhost:${PORT}`;
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || `${backendUrl}/api/auth/microsoft/callback`;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";

    // 1. Exchange authorization code for access token
    const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error("Token exchange failed:", errText);
      return res.status(500).send("Failed to retrieve token from Microsoft");
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // 2. Fetch user profile from Microsoft Graph API
    const profileResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: "Bearer " + accessToken },
    });

    if (!profileResponse.ok) {
      console.error("Graph API profile fetch failed");
      return res.status(500).send("Failed to fetch user profile from Microsoft Graph");
    }

    const graphUser = await profileResponse.json();
    const email = graphUser.mail || graphUser.userPrincipalName || "";
    const name = graphUser.displayName || graphUser.givenName || "Microsoft User";

    if (!email) {
      return res.status(400).send("Microsoft account must have a configured email address");
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Enforce email domain restriction
    if (!trimmedEmail.endsWith("@plaksha.edu.in")) {
      return res.redirect(`${frontendUrl}/?error=${encodeURIComponent("Only @plaksha.edu.in email addresses are allowed to create accounts.")}`);
    }

    const id = trimmedEmail.split("@")[0].replace(/[^a-z0-9]+/g, "_");

    // 3. Register user if not exists
    let userRows = await db("SELECT * FROM users WHERE id = $1 OR email = $2", [id, trimmedEmail]);
    if (!userRows.length) {
      // Do NOT create DB record yet. Generate temporary JIT token
      const tempToken = jwt.sign(
        { id, name: name.trim(), email: trimmedEmail, temp: true },
        JWT_SECRET,
        { expiresIn: "15m" }
      );
      return res.redirect(`${frontendUrl}/?temp_token=${tempToken}`);
    }

    const user = userRows[0];
    // 4. Generate JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    // 5. Redirect back to frontend
    res.redirect(`${frontendUrl}/?token=${token}`);
  } catch (err) {
    console.error("SSO callback error:", err);
    res.status(500).send("Internal server error during SSO login");
  }
});

// POST /api/auth/register-sso
app.post("/api/auth/register-sso", async (req, res) => {
  try {
    const { temp_token, deptId } = req.body;
    if (!temp_token || !deptId) {
      return res.status(400).json({ error: "Temporary token and department ID are required" });
    }

    // 1. Verify temp_token
    let decoded;
    try {
      decoded = jwt.verify(temp_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired temporary token" });
    }

    if (!decoded.temp) {
      return res.status(400).json({ error: "Invalid token type" });
    }

    const { id, name, email } = decoded;

    // 2. Validate email domain again
    if (!email.trim().toLowerCase().endsWith("@plaksha.edu.in")) {
      return res.status(400).json({ error: "Only @plaksha.edu.in email addresses are allowed" });
    }

    // 3. Check if user already exists
    const userRows = await db("SELECT * FROM users WHERE id = $1 OR email = $2", [id, email.trim()]);
    if (userRows.length) {
      return res.status(400).json({ error: "User already registered" });
    }

    // 4. Create user record
    const dummyPass = await bcrypt.hash("sso_user_" + Math.random(), 10);
    await db(
      `INSERT INTO users (id, name, email, password_hash, role, dept_ids, approver_assignments)
       VALUES ($1, $2, $3, $4, 'requester', $5, '[]')`,
      [id, name.trim(), email.trim(), dummyPass, JSON.stringify([deptId])]
    );

    const freshRows = await db("SELECT * FROM users WHERE id = $1", [id]);
    const user = freshRows[0];

    // 5. Generate standard JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({ token, user: mapUser(user) });
  } catch (err) {
    console.error("SSO JIT registration error:", err);
    res.status(500).json({ error: "Failed to complete registration" });
  }
});


// ═══════════════════════════════════════════════════════════════
// USERS ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/users  (admin: all users; others: just public list for login quick-select)
app.get("/api/users", auth, async (req, res) => {
  try {
    const rows = await db("SELECT * FROM users ORDER BY name");
    // Non-admins get limited data (no password hash, just for display)
    const users = rows.map(r => ({
      ...mapUser(r),
      // Include password only for admin quick-login helper
      ...(req.user.role === "admin" ? { password: "**hidden**" } : {}),
    }));
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/users/public  (no auth — for quick login list on login screen)
app.get("/api/users/public", async (req, res) => {
  try {
    const rows = await db("SELECT id, name, role FROM users ORDER BY name");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/users  (admin only)
app.post("/api/users", auth, adminOnly, async (req, res) => {
  try {
    const { id, name, email, password, role, deptIds, approverAssignments } = req.body;
    if (!id || !name || !email || !password || !role) return res.status(400).json({ error: "Missing fields" });

    if (id.trim().toLowerCase() !== "admin" && !email.trim().toLowerCase().endsWith("@plaksha.edu.in")) {
      return res.status(400).json({ error: "Only @plaksha.edu.in email addresses are allowed" });
    }

    const hash = await bcrypt.hash(password, 10);
    await db(
      upsertUserSql(),
      [id.trim(), name.trim(), email.trim(), hash, role,
       JSON.stringify(deptIds || []),
       JSON.stringify(approverAssignments || [])]
    );
    const rows = await db("SELECT * FROM users WHERE id = $1", [id.trim()]);
    res.json(mapUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/users/me - Update own profile (name, email, password)
app.put("/api/users/me", auth, async (req, res) => {
  try {
    const { name, email, password, deptIds } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Name and email are required" });

    const trimmedEmail = email.trim().toLowerCase();
    const currentRows = await db("SELECT email, role FROM users WHERE id = $1", [req.user.id]);
    const currentEmail = currentRows[0]?.email?.trim()?.toLowerCase();

    if (req.user.id !== "admin" && trimmedEmail !== currentEmail && !trimmedEmail.endsWith("@plaksha.edu.in")) {
      return res.status(400).json({ error: "Only @plaksha.edu.in email addresses are allowed" });
    }

    const params = [name.trim(), trimmedEmail, req.user.id];
    let sql = `UPDATE users SET name=$1, email=$2 WHERE id=$3`;
    
    if (deptIds !== undefined) {
      params.push(JSON.stringify(deptIds));
      sql = `UPDATE users SET name=$1, email=$2, dept_ids=$4 WHERE id=$3`;
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        sql = `UPDATE users SET name=$1, email=$2, dept_ids=$4, password_hash=$5 WHERE id=$3`;
        params.push(hash);
      }
    } else {
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        sql = `UPDATE users SET name=$1, email=$2, password_hash=$4 WHERE id=$3`;
        params.push(hash);
      }
    }

    await db(sql, params);
    const rows = await db("SELECT * FROM users WHERE id = $1", [req.user.id]);
    res.json(mapUser(rows[0]));
  } catch (err) {
    console.error("PUT /api/users/me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/users/:id  (admin only)
app.put("/api/users/:id", auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, deptIds, approverAssignments } = req.body;
    
    if (req.params.id !== "admin" && !email.trim().toLowerCase().endsWith("@plaksha.edu.in")) {
      return res.status(400).json({ error: "Only @plaksha.edu.in email addresses are allowed" });
    }

    const params = [
      name, email, role,
      JSON.stringify(deptIds || []),
      JSON.stringify(approverAssignments || []),
      req.params.id
    ];
    let sql = `UPDATE users SET name=$1, email=$2, role=$3, dept_ids=$4, approver_assignments=$5 WHERE id=$6`;
    if (password && password !== "**hidden**") {
      const hash = await bcrypt.hash(password, 10);
      sql = `UPDATE users SET name=$1, email=$2, role=$3, dept_ids=$4, approver_assignments=$5, password_hash=$7 WHERE id=$6`;
      params.push(hash);
    }
    await db(sql, params);
    const rows = await db("SELECT * FROM users WHERE id = $1", [req.params.id]);
    res.json(mapUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/users/:id  (admin only)
app.delete("/api/users/:id", auth, adminOnly, async (req, res) => {
  try {
    await db("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// DEPARTMENTS ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/depts/public  (no auth — for signup department selection dropdown)
app.get("/api/depts/public", async (req, res) => {
  try {
    const rows = await db("SELECT id, name FROM departments ORDER BY name");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/depts
app.get("/api/depts", auth, async (req, res) => {
  try {
    const rows = await db("SELECT * FROM departments ORDER BY name");
    res.json(rows.map(mapDept));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/depts  (admin — upsert)
app.post("/api/depts", auth, adminOnly, async (req, res) => {
  try {
    const { id, name, notes, budget, spent, reserved, color, codes } = req.body;
    await db(
      upsertDepartmentSql(),
      [id, name, notes||"", budget||0, spent||0, reserved||0, color||"#007878",
       JSON.stringify(codes||[])]
    );
    const rows = await db("SELECT * FROM departments WHERE id = $1", [id]);
    res.json(mapDept(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/depts/bulk  (admin — replace all depts, used by import)
app.post("/api/depts/bulk", auth, adminOnly, async (req, res) => {
  try {
    const depts = req.body;
    if (!Array.isArray(depts)) return res.status(400).json({ error: "Expected array" });
    for (const d of depts) {
      await db(
        upsertDepartmentSql(),
        [d.id, d.name, d.notes||"", d.budget||0, d.spent||0, d.reserved||0,
         d.color||"#007878", JSON.stringify(d.codes||[])]
      );
    }
    const rows = await db("SELECT * FROM departments ORDER BY name");
    res.json(rows.map(mapDept));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/depts/:id  (admin — update financials like spent/reserved)
app.put("/api/depts/:id", auth, async (req, res) => {
  try {
    const { name, notes, budget, spent, reserved, color, codes } = req.body;
    await db(
      `UPDATE departments SET name=$1, notes=$2, budget=$3, spent=$4, reserved=$5,
       color=$6, codes=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$8`,
      [name, notes||"", budget||0, spent||0, reserved||0,
       color||"#007878", JSON.stringify(codes||[]), req.params.id]
    );
    const rows = await db("SELECT * FROM departments WHERE id = $1", [req.params.id]);
    res.json(mapDept(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/depts/:id  (admin only)
app.delete("/api/depts/:id", auth, adminOnly, async (req, res) => {
  try {
    const indents = await db("SELECT id FROM indents WHERE dept_id = $1 LIMIT 1", [req.params.id]);
    if (indents.length) return res.status(400).json({ error: "Cannot delete: department has indent history" });
    await db("DELETE FROM departments WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// INDENTS ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/indents  (filtered by user role)
app.get("/api/indents", auth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === "admin" || req.user.role === "procurement") {
      rows = await db("SELECT * FROM indents ORDER BY submitted_at DESC");
    } else if (req.user.role === "requester") {
      rows = await db(
        "SELECT * FROM indents WHERE submitted_by = $1 ORDER BY submitted_at DESC",
        [req.user.id]
      );
    } else if (req.user.role === "approver") {
      // Approver sees indents from their assigned departments
      const userRows = await db("SELECT approver_assignments FROM users WHERE id = $1", [req.user.id]);
      const assignments = j(userRows[0]?.approver_assignments, []);
      const deptIds = assignments.map(a => a.deptId);
      if (!deptIds.length) { rows = []; }
      else {
        rows = await db(
          isMysql
            ? "SELECT * FROM indents WHERE dept_id IN (?) ORDER BY submitted_at DESC"
            : "SELECT * FROM indents WHERE dept_id = ANY($1) ORDER BY submitted_at DESC",
          [deptIds]
        );
      }
    } else {
      rows = [];
    }
    res.json(rows.map(mapIndent));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/indents  (create new indent)
app.post("/api/indents", auth, async (req, res) => {
  try {
    const { id, deptId, title, notes, attachments, atts, items, status, level,
            submittedBy, submittedAt, history } = req.body;
    const finalAttachments = attachments || atts || [];

    await db(
      `INSERT INTO indents
        (id, dept_id, title, notes, attachments, items, status, level,
         submitted_by, submitted_at, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, deptId, title||"", notes||"",
       JSON.stringify(finalAttachments),
       JSON.stringify(items||[]),
       status||"reserved", level||0,
       submittedBy, submittedAt||new Date(),
       JSON.stringify(history||[])]
    );
    // Update dept reserved
    await db(
      "UPDATE departments SET reserved = reserved + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [items.reduce((s,it)=>s+Number(it.amount||0),0), deptId]
    );
    const rows = await db("SELECT * FROM indents WHERE id = $1", [id]);
    const indent = mapIndent(rows[0]);

    // Send Email Async
    (async () => {
      try {
        // 1. Fetch requester details
        const reqRows = await db("SELECT * FROM users WHERE id = $1", [submittedBy]);
        const requester = reqRows.length ? mapUser(reqRows[0]) : { id: submittedBy, name: submittedBy, email: "" };

        // 2. Fetch L1 approvers
        const appRows = await db("SELECT * FROM users WHERE role = 'approver'");
        const l1Approvers = [];
        appRows.map(mapUser).forEach(u => {
          u.approverAssignments.forEach(a => {
            if (a.deptId === deptId && Number(a.approverLevel) === 0) {
              l1Approvers.push(u);
            }
          });
        });

        await mailer.sendIndentSubmittedMail(indent, requester, l1Approvers);

        // Send Teams Notification
        const deptRows = await db("SELECT name FROM departments WHERE id = $1", [deptId]);
        const deptName = deptRows.length ? deptRows[0].name : deptId;
        await teams.notifyIndentSubmitted(indent, requester, deptName);

        // Trigger MS Teams Approval Flows
        l1Approvers.forEach(approver => {
          if (approver.email) {
            teams.triggerTeamsApproval(indent, requester, approver, deptName, 0);
          }
        });
      } catch (err) {
        console.error("[Mailer/Teams Error during submit hook]:", err);
      }
    })();

    res.json(indent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/indents/:id  (update indent — approval actions, proc closure, rfq)
app.put("/api/indents/:id", auth, async (req, res) => {
  try {
    const upd = req.body;
    // Get old indent to compute financial delta
    const oldRows = await db("SELECT * FROM indents WHERE id = $1", [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: "Not found" });
    const old = mapIndent(oldRows[0]);

    const finalAttachments = upd.attachments || upd.atts || [];

    await db(
      `UPDATE indents SET
        title=$1, notes=$2, attachments=$3, items=$4, status=$5, level=$6,
        history=$7, proc_closed=$8, proc_closed_at=$9, proc_closed_by=$10,
        rfq_sent_at=$11, rfq_vendors=$12, rfq_sent_by=$13,
        updated_at=CURRENT_TIMESTAMP
       WHERE id=$14`,
      [
        upd.title||"", upd.notes||"",
        JSON.stringify(finalAttachments),
        JSON.stringify(upd.items||[]),
        upd.status||old.status,
        upd.level ?? old.level,
        JSON.stringify(upd.history||[]),
        upd.procClosed||false,
        upd.procClosedAt||null,
        upd.procClosedBy||null,
        upd.rfqSentAt||null,
        JSON.stringify(upd.rfqVendors||[]),
        upd.rfqSentBy||null,
        req.params.id
      ]
    );

    // Recompute dept financials from all indents
    const allIndents = await db("SELECT items, status FROM indents WHERE dept_id = $1", [old.deptId]);
    let newSpent = 0, newReserved = 0;
    for (const ind of allIndents) {
      const its = j(ind.items, []);
      its.forEach(it => {
        if (it.itemStatus === "approved") newSpent += Number(it.amount||0);
        else if (!it.itemStatus || it.itemStatus === "pending") newReserved += Number(it.amount||0);
      });
    }
    await db(
      "UPDATE departments SET spent=$1, reserved=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3",
      [newSpent, newReserved, old.deptId]
    );

    const rows = await db("SELECT * FROM indents WHERE id = $1", [req.params.id]);
    const updatedIndent = mapIndent(rows[0]);

    // Trigger emails async
    (async () => {
      try {
        // 1. Fetch requester details
        const reqRows = await db("SELECT * FROM users WHERE id = $1", [old.submittedBy]);
        const requester = reqRows.length ? mapUser(reqRows[0]) : { id: old.submittedBy, name: old.submittedBy, email: "" };

        // Extract last history item for notes
        const lastHist = upd.history && upd.history.length ? upd.history[upd.history.length - 1] : null;
        const comment = lastHist ? lastHist.note : "";

        // 2. Identify the transition
        const isProcClosedTransition = updatedIndent.procClosed && !old.procClosed;
        const isRejectedTransition = updatedIndent.status === "rejected" && old.status !== "rejected";
        const isRevisionTransition = updatedIndent.status === "revision" && old.status !== "revision";
        
        const isApprovedTransition = (updatedIndent.status === "approved" || updatedIndent.status === "partial") && old.status === "reserved";
        const isForwardedTransition = updatedIndent.status === "reserved" && old.status === "reserved" && (updatedIndent.level > old.level);

        const deptRows = await db("SELECT name FROM departments WHERE id = $1", [old.deptId]);
        const deptName = deptRows.length ? deptRows[0].name : old.deptId;

        if (isProcClosedTransition) {
          const closerRows = await db("SELECT * FROM users WHERE id = $1", [updatedIndent.procClosedBy]);
          const closer = closerRows.length ? mapUser(closerRows[0]) : { id: updatedIndent.procClosedBy, name: updatedIndent.procClosedBy };
          await mailer.sendIndentClosedMail(updatedIndent, requester, closer);
          await teams.notifyIndentClosed(updatedIndent, requester, deptName, closer);
        } else if (isRejectedTransition) {
          await mailer.sendIndentRejectedMail(updatedIndent, requester, comment);
          await teams.notifyIndentRejected(updatedIndent, requester, deptName, comment);
        } else if (isRevisionTransition) {
          await mailer.sendIndentRevisionMail(updatedIndent, requester, comment);
          await teams.notifyIndentRevision(updatedIndent, requester, deptName, comment);
        } else if (isApprovedTransition) {
          // Fetch all procurement users
          const procRows = await db("SELECT * FROM users WHERE role = 'procurement'");
          const procUsers = procRows.map(mapUser);
          await mailer.sendIndentFinalApprovedMail(updatedIndent, requester, procUsers, comment);
          await teams.notifyIndentFinalApproved(updatedIndent, requester, deptName);
        } else if (isForwardedTransition) {
          // Fetch next level approvers (at updatedIndent.level)
          const appRows = await db("SELECT * FROM users WHERE role = 'approver'");
          const nextApprovers = [];
          appRows.map(mapUser).forEach(u => {
            u.approverAssignments.forEach(a => {
              if (a.deptId === old.deptId && Number(a.approverLevel) === Number(updatedIndent.level)) {
                nextApprovers.push(u);
              }
            });
          });
          await mailer.sendIndentForwardedMail(updatedIndent, requester, nextApprovers, comment, old.level);
          await teams.notifyIndentForwarded(updatedIndent, requester, deptName, updatedIndent.level + 1);

          // Trigger MS Teams Approval Flows for next level
          nextApprovers.forEach(approver => {
            if (approver.email) {
              teams.triggerTeamsApproval(updatedIndent, requester, approver, deptName, updatedIndent.level);
            }
          });
        }
      } catch (err) {
        console.error("[Mailer Error during update hook]:", err);
      }
    })();

    res.json(updatedIndent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/indents/:id/rfq  (Send RFQ via SMTP)
app.post("/api/indents/:id/rfq", auth, async (req, res) => {
  try {
    const { emails } = req.body;
    if (!emails || !emails.length) return res.status(400).json({ error: "Emails required" });

    const indentRows = await db("SELECT * FROM indents WHERE id = $1", [req.params.id]);
    if (!indentRows.length) return res.status(404).json({ error: "Indent not found" });
    const indent = mapIndent(indentRows[0]);

    const deptRows = await db("SELECT * FROM departments WHERE id = $1", [indent.deptId]);
    const dept = deptRows.length ? mapDept(deptRows[0]) : null;

    // Build approved items text
    const approvedItems = indent.items.filter(it => it.itemStatus === "approved");
    const itemsTable = approvedItems.map((it, i) =>
      `${i+1}. ${it.desc} | Code: ${it.code} | Qty: ${it.qty} ${it.unit || "Nos"} | Budget: Rs. ${Number(it.amount||0).toLocaleString("en-IN")}`
    ).join("\n");

    const subject = `Request for Quotation - ${indent.title || indent.id} [${indent.id}]`;
    const bodyText =
      `Dear Vendor,\n\n` +
      `We invite you to submit your best quotation for the items listed below.\n\n` +
      `INDENT DETAILS\n` +
      `--------------\n` +
      `Indent ID   : ${indent.id}\n` +
      `Title       : ${indent.title || indent.id}\n` +
      `Department  : ${dept ? dept.name : indent.deptId}\n` +
      `Date        : ${new Date().toLocaleDateString("en-IN")}\n\n` +
      `ITEMS REQUIRED\n` +
      `--------------\n` +
      `${itemsTable}\n\n` +
      `TERMS\n` +
      `-----\n` +
      `1. Submit quotation within 7 working days.\n` +
      `2. Include unit price, GST, delivery charges and lead time.\n` +
      `3. Attach product specification sheets where applicable.\n` +
      `4. Quotation validity: minimum 30 days.\n\n` +
      `Please reply to this email with your detailed quotation.\n\n` +
      `Thank you for your interest.\n\n` +
      `Regards,\n` +
      `${req.user.name}\n` +
      `Procurement Team`;

    const errors = [];
    for (const email of emails) {
      try {
        await mailer.sendMail(email, subject, bodyText.replace(/\n/g, "<br>"), bodyText);
      } catch (err) {
        errors.push(`${email}: ${err.message}`);
      }
    }

    if (errors.length) {
      return res.status(500).json({ error: `Failed for: ${errors.join("; ")}` });
    }

    // Update RFQ in DB
    const now = new Date().toISOString();
    const updatedRfqVendors = [...new Set([...(indent.rfqVendors || []), ...emails])];
    await db(
      `UPDATE indents SET rfq_sent_at = $1, rfq_vendors = $2, rfq_sent_by = $3 WHERE id = $4`,
      [now, JSON.stringify(updatedRfqVendors), req.user.id, indent.id]
    );

    res.json({ ok: true, rfqSentAt: now, rfqVendors: updatedRfqVendors, rfqSentBy: req.user.id });
  } catch (err) {
    console.error("RFQ send error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/teams-approvals/callback (MS Teams Power Automate Callback)
app.post("/api/teams-approvals/callback", async (req, res) => {
  const secretKey = process.env.TEAMS_CALLBACK_KEY || "teams_approval_secret_key";
  const incomingKey = req.headers["x-callback-key"];
  if (incomingKey !== secretKey) {
    return res.status(401).json({ error: "Unauthorized callback" });
  }

  const { indentId, action, by, note } = req.body;
  if (!indentId || !action || !by) {
    return res.status(400).json({ error: "Missing fields: indentId, action, and by are required" });
  }

  try {
    // 1. Fetch indent
    const indentRows = await db("SELECT * FROM indents WHERE id = $1", [indentId]);
    if (!indentRows.length) return res.status(404).json({ error: "Indent not found" });
    const indent = mapIndent(indentRows[0]);

    if (indent.status !== "reserved") {
      return res.status(400).json({ error: "Indent is not in pending status" });
    }

    // 2. Fetch approver details
    const userRows = await db("SELECT * FROM users WHERE id = $1", [by]);
    if (!userRows.length) return res.status(404).json({ error: "Approver user not found" });
    const approver = mapUser(userRows[0]);

    // 3. Check if this approver is authorized for the current stage/level
    const assignments = approver.approverAssignments;
    const currentAssignment = assignments.find(a => a.deptId === indent.deptId && Number(a.approverLevel) === Number(indent.level));
    if (!currentAssignment && approver.role !== "admin") {
      return res.status(403).json({ error: "Approver not authorized for this department and level" });
    }

    // 4. Fetch all department approvers to find max level
    const appRows = await db("SELECT * FROM users WHERE role = 'approver'");
    const deptApprovers = [];
    appRows.map(mapUser).forEach(u => {
      u.approverAssignments.forEach(a => {
        if (a.deptId === indent.deptId) {
          deptApprovers.push({ userId: u.id, name: u.name, level: Number(a.approverLevel) });
        }
      });
    });

    // Fetch dynamic approval limits configuration
    const configRows = await db(`SELECT value FROM app_config WHERE ${isMysql ? "config_key" : "key"} = 'approval_limits'`);
    const limits = configRows.length ? j(configRows[0].value, { l1Limit: 200000, l2Limit: 500000 }) : { l1Limit: 200000, l2Limit: 500000 };
    const l1Limit = Number(limits.l1Limit ?? 200000);
    const l2Limit = Number(limits.l2Limit ?? 500000);

    const amount = (indent.items || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    let reqLevel = 0;
    if (amount < l1Limit) reqLevel = 0;
    else if (amount < l2Limit) reqLevel = 1;
    else reqLevel = 2;

    const deptMaxLevel = deptApprovers.length ? Math.max(...deptApprovers.map(a => a.level)) : 0;
    const maxLevel = Math.min(reqLevel, deptMaxLevel);

    // 5. Build new history entry
    const histEntry = {
      action,
      by: approver.id,
      name: approver.name,
      at: new Date().toISOString(),
      note: note || "Actioned via Teams Approvals App",
      level: indent.level
    };
    const newHistory = [...(indent.history || []), histEntry];

    let newStatus = indent.status;
    let newLevel = indent.level;
    let newItems = [...(indent.items || [])];

    if (action === "revision") {
      newStatus = "revision";
      newItems = newItems.map(it => it.itemStatus === "rejected" ? it : { ...it, itemStatus: "pending" });
    } else if (action === "reject") {
      newStatus = "rejected";
      newItems = newItems.map(it => (!it.itemStatus || it.itemStatus === "pending") ? { ...it, itemStatus: "rejected" } : it);
    } else if (action === "approve") {
      const isFinal = indent.level >= maxLevel;
      if (isFinal) {
        newItems = newItems.map(it => {
          if (it.itemStatus && it.itemStatus !== "pending") return it;
          return { ...it, itemStatus: "approved" };
        });
        newStatus = "approved";
      } else {
        newLevel = indent.level + 1;
      }
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }

    // 6. Save back to DB
    await db(
      `UPDATE indents SET status=$1, level=$2, items=$3, history=$4 WHERE id=$5`,
      [newStatus, newLevel, JSON.stringify(newItems), JSON.stringify(newHistory), indent.id]
    );

    // 7. Recompute department financials
    const allIndents = await db("SELECT items, status FROM indents WHERE dept_id = $1", [indent.deptId]);
    let newSpent = 0, newReserved = 0;
    for (const ind of allIndents) {
      const its = j(ind.items, []);
      its.forEach(it => {
        if (it.itemStatus === "approved") newSpent += Number(it.amount||0);
        else if (!it.itemStatus || it.itemStatus === "pending") newReserved += Number(it.amount||0);
      });
    }
    await db(
      "UPDATE departments SET spent=$1, reserved=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3",
      [newSpent, newReserved, indent.deptId]
    );

    // Fetch updated indent
    const freshRows = await db("SELECT * FROM indents WHERE id = $1", [indent.id]);
    const updatedIndent = mapIndent(freshRows[0]);

    // 8. Trigger emails and Teams webhook notifications asynchronously
    (async () => {
      try {
        const reqRows = await db("SELECT * FROM users WHERE id = $1", [indent.submittedBy]);
        const requester = reqRows.length ? mapUser(reqRows[0]) : { id: indent.submittedBy, name: indent.submittedBy, email: "" };
        const commentText = note || "Actioned via Teams Approvals App";

        const deptRows = await db("SELECT name FROM departments WHERE id = $1", [indent.deptId]);
        const deptName = deptRows.length ? deptRows[0].name : indent.deptId;

        if (newStatus === "rejected") {
          await mailer.sendIndentRejectedMail(updatedIndent, requester, commentText);
          await teams.notifyIndentRejected(updatedIndent, requester, deptName, commentText);
        } else if (newStatus === "revision") {
          await mailer.sendIndentRevisionMail(updatedIndent, requester, commentText);
          await teams.notifyIndentRevision(updatedIndent, requester, deptName, commentText);
        } else if (newStatus === "approved") {
          const procRows = await db("SELECT * FROM users WHERE role = 'procurement'");
          const procUsers = procRows.map(mapUser);
          await mailer.sendIndentFinalApprovedMail(updatedIndent, requester, procUsers, commentText);
          await teams.notifyIndentFinalApproved(updatedIndent, requester, deptName);
        } else if (newLevel > indent.level) {
          const appRows = await db("SELECT * FROM users WHERE role = 'approver'");
          const nextApprovers = [];
          appRows.map(mapUser).forEach(u => {
            u.approverAssignments.forEach(a => {
              if (a.deptId === indent.deptId && Number(a.approverLevel) === Number(newLevel)) {
                nextApprovers.push(u);
              }
            });
          });
          await mailer.sendIndentForwardedMail(updatedIndent, requester, nextApprovers, commentText, indent.level);
          await teams.notifyIndentForwarded(updatedIndent, requester, deptName, newLevel + 1);

          // Trigger Teams Approval flow for the next level
          nextApprovers.forEach(approver => {
            if (approver.email) {
              teams.triggerTeamsApproval(updatedIndent, requester, approver, deptName, newLevel);
            }
          });
        }
      } catch (err) {
        console.error("[Callback Hooks Error]:", err);
      }
    })();

    res.json({ success: true, status: newStatus, level: newLevel });
  } catch (err) {
    console.error("Callback endpoint error:", err);
    res.status(500).json({ error: "Callback processing failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// APP CONFIG ROUTES  (EmailJS etc.)
// ═══════════════════════════════════════════════════════════════

// GET /api/config/:key
app.get("/api/config/:key", auth, async (req, res) => {
  try {
    const rows = await db(`SELECT value FROM app_config WHERE ${isMysql ? "config_key" : "key"} = $1`, [req.params.key]);
    res.json(rows.length ? j(rows[0].value, {}) : {});
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/config/:key  (procurement or admin)
app.put("/api/config/:key", auth, async (req, res) => {
  try {
    await db(
      upsertConfigSql(),
      [req.params.key, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get("/api/health", async (req, res) => {
  try {
    await db("SELECT 1");
    res.json({ status: "ok", db: "connected", time: new Date() });
  } catch (err) {
    res.status(500).json({ status: "error", db: "disconnected", error: err.message });
  }
});

// ── Serve React Frontend (production) ───────────────────────────────────────
// When dist/ exists, serve the built React app for all non-API routes.
// This lets the Node server run both the API and the frontend on one port.
const distPath = path.join(__dirname, "dist");
if (require("fs").existsSync(distPath)) {
  app.use(express.static(distPath));
  // Catch-all: serve index.html for any non-API route (SPA client-side routing)
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
  console.log(`Serving React frontend from: ${distPath}`);
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PlakshaBudget API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
// Trigger nodemon restart for env update
