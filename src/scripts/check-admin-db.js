import { checkAdminDatabase } from "../db/admin-repository.js";

try {
  const result = await checkAdminDatabase();
  console.log("Turso admin database connection OK.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Failed to connect to Turso admin database.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
