require("dotenv").config();

const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

async function main() {
  const password = process.argv[2] || "admin123";
  const hash = await bcrypt.hash(password, 10);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    database: process.env.DB_NAME || "budgetflow",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
  });

  try {
    await connection.execute(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      [hash, "admin"]
    );
    console.log("Admin password reset.");
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("Admin password reset failed:", error.message);
  process.exit(1);
});
