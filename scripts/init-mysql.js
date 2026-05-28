require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

function escapeIdentifier(value) {
  return String(value).replace(/`/g, "``");
}

async function main() {
  const dbName = process.env.DB_NAME || "budgetflow";
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    multipleStatements: true,
  });

  try {
    const safeDbName = escapeIdentifier(dbName);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${safeDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${safeDbName}\``);

    const schemaPath = path.join(__dirname, "..", "schema.mysql.sql");
    const schema = await fs.readFile(schemaPath, "utf8");
    await connection.query(schema);

    console.log(`MySQL database '${dbName}' is ready.`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("MySQL initialization failed:", error.message);
  process.exit(1);
});
