import { loadEnvFile } from "../lib/load-env.js";

loadEnvFile();

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function loadClientFactory() {
  const module = await import("@libsql/client");
  return module.createClient;
}

export async function createTursoClient() {
  const createClient = await loadClientFactory();

  return createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
  });
}

export function getTursoConfigStatus() {
  return {
    hasUrl: Boolean(process.env.TURSO_DATABASE_URL),
    hasAuthToken: Boolean(process.env.TURSO_AUTH_TOKEN),
  };
}

export function isTursoConfigured() {
  const status = getTursoConfigStatus();
  return status.hasUrl && status.hasAuthToken;
}
