// Load .env into process.env before config is read. No-op if .env is absent.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  // no .env — terminal alerts still work
}
