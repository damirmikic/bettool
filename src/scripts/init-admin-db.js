import { initializeAdminSchema } from "../db/admin-repository.js";

try {
  const result = await initializeAdminSchema();
  console.log("Admin schema initialized.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Failed to initialize admin schema.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
