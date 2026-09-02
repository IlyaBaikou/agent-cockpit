const BASE_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
] as const;

export function buildAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forwarded = (source.AGENT_FORWARD_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const allowed = new Set<string>([...BASE_ENVIRONMENT_ALLOWLIST, ...forwarded]);
  const result: NodeJS.ProcessEnv = {};

  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}
