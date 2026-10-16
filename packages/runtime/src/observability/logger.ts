import { getTraceContext } from "./traceContext.ts";

type LogFields = Record<string, string | number | boolean | undefined>;

export function createLogger(serviceName: string) {
  function write(severity: "INFO" | "WARN" | "ERROR", message: string, fields: LogFields = {}) {
    const context = getTraceContext();
    const record = {
      timestamp: new Date().toISOString(),
      severity,
      serviceName,
      message,
      ...(context
        ? {
            correlationId: context.correlationId,
            traceId: context.traceId,
            spanId: context.spanId,
          }
        : {}),
      ...fields,
    };

    const output = JSON.stringify(record);
    if (severity === "ERROR") console.error(output);
    else if (severity === "WARN") console.warn(output);
    else console.log(output);
  }

  return {
    info: (message: string, fields?: LogFields) => write("INFO", message, fields),
    warn: (message: string, fields?: LogFields) => write("WARN", message, fields),
    error: (message: string, fields?: LogFields) => write("ERROR", message, fields),
  };
}
