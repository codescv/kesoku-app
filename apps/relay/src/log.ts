/** Minimal structured logger. Never pass tokens, secrets, pairing codes or ID tokens as fields. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(severity: string, msg: string, fields?: Record<string, unknown>): void {
  // One JSON object per line (Cloud Run / Cloud Logging picks up `severity` + `message`).
  const line = JSON.stringify({ severity, message: msg, ...fields });
  if (severity === 'ERROR' || severity === 'WARNING') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const consoleLogger: Logger = {
  info: (m, f) => emit('INFO', m, f),
  warn: (m, f) => emit('WARNING', m, f),
  error: (m, f) => emit('ERROR', m, f),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
