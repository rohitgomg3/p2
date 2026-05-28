-- BudgetFlow Database Schema
-- Compatible with PostgreSQL and MySQL (notes where syntax differs)

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id               VARCHAR(100) PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  role             VARCHAR(50)  NOT NULL CHECK (role IN ('admin','requester','approver','procurement')),
  dept_ids         TEXT,          -- JSON array of dept IDs (for requesters)
  approver_assignments TEXT,      -- JSON array of {deptId, approverLevel} (for approvers)
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- DEPARTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS departments (
  id               VARCHAR(100) PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  notes            TEXT,
  budget           DECIMAL(18,2) DEFAULT 0,
  spent            DECIMAL(18,2) DEFAULT 0,
  reserved         DECIMAL(18,2) DEFAULT 0,
  color            VARCHAR(20),
  codes            TEXT NOT NULL DEFAULT '[]',   -- JSON array of {code,desc,amount,deptId}
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INDENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS indents (
  id               VARCHAR(100) PRIMARY KEY,
  dept_id          VARCHAR(100) NOT NULL REFERENCES departments(id),
  title            VARCHAR(500),
  notes            TEXT,
  attachments      TEXT DEFAULT '[]',   -- JSON array of {name,size,type,data}
  items            TEXT NOT NULL DEFAULT '[]', -- JSON array of line items
  status           VARCHAR(50) DEFAULT 'reserved'
                   CHECK (status IN ('reserved','approved','partial','rejected','revision')),
  level            INT DEFAULT 0,
  submitted_by     VARCHAR(100) NOT NULL REFERENCES users(id),
  submitted_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  history          TEXT DEFAULT '[]',  -- JSON array of approval history entries
  proc_closed      BOOLEAN DEFAULT FALSE,
  proc_closed_at   TIMESTAMP,
  proc_closed_by   VARCHAR(100) REFERENCES users(id),
  rfq_sent_at      TIMESTAMP,
  rfq_vendors      TEXT DEFAULT '[]',  -- JSON array of vendor email strings
  rfq_sent_by      VARCHAR(100) REFERENCES users(id),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- APP CONFIG (EmailJS settings etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_config (
  key              VARCHAR(100) PRIMARY KEY,
  value            TEXT,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_indents_dept     ON indents(dept_id);
CREATE INDEX IF NOT EXISTS idx_indents_status   ON indents(status);
CREATE INDEX IF NOT EXISTS idx_indents_by       ON indents(submitted_by);
CREATE INDEX IF NOT EXISTS idx_indents_submitted ON indents(submitted_at);

-- ============================================================
-- SEED: Default admin user  (password: admin123)
-- BCrypt hash of "admin123" with 10 rounds
-- ============================================================
INSERT INTO users (id, name, password_hash, role)
VALUES ('admin', 'Finance Admin', '$2b$10$YDQO1XIkcmmThBzhM8pWx.FI3j/9m2NHyMtUBo2e58kVaGBjWMq1C', 'admin')
ON CONFLICT (id) DO NOTHING;
