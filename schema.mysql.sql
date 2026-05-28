CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','requester','approver','procurement') NOT NULL,
  dept_ids LONGTEXT,
  approver_assignments LONGTEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  notes LONGTEXT,
  budget DECIMAL(18,2) DEFAULT 0,
  spent DECIMAL(18,2) DEFAULT 0,
  reserved DECIMAL(18,2) DEFAULT 0,
  color VARCHAR(20),
  codes LONGTEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS indents (
  id VARCHAR(100) PRIMARY KEY,
  dept_id VARCHAR(100) NOT NULL,
  title VARCHAR(500),
  notes LONGTEXT,
  attachments LONGTEXT DEFAULT '[]',
  items LONGTEXT NOT NULL DEFAULT '[]',
  status ENUM('reserved','approved','partial','rejected','revision') DEFAULT 'reserved',
  level INT DEFAULT 0,
  submitted_by VARCHAR(100) NOT NULL,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  history LONGTEXT DEFAULT '[]',
  proc_closed TINYINT(1) DEFAULT 0,
  proc_closed_at TIMESTAMP NULL,
  proc_closed_by VARCHAR(100) NULL,
  rfq_sent_at TIMESTAMP NULL,
  rfq_vendors LONGTEXT DEFAULT '[]',
  rfq_sent_by VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_indents_dept (dept_id),
  INDEX idx_indents_status (status),
  INDEX idx_indents_by (submitted_by),
  INDEX idx_indents_submitted (submitted_at),
  CONSTRAINT fk_indents_dept FOREIGN KEY (dept_id) REFERENCES departments(id),
  CONSTRAINT fk_indents_submitted_by FOREIGN KEY (submitted_by) REFERENCES users(id),
  CONSTRAINT fk_indents_proc_closed_by FOREIGN KEY (proc_closed_by) REFERENCES users(id),
  CONSTRAINT fk_indents_rfq_sent_by FOREIGN KEY (rfq_sent_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_config (
  config_key VARCHAR(100) PRIMARY KEY,
  value LONGTEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO users (id, name, email, password_hash, role)
VALUES ('admin', 'Finance Admin', 'admin@example.com', '$2b$10$YDQO1XIkcmmThBzhM8pWx.FI3j/9m2NHyMtUBo2e58kVaGBjWMq1C', 'admin')
ON DUPLICATE KEY UPDATE id = id;
