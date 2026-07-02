export interface TraceEvent {
  id: string;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  routeId?: string;
}

export type TraceFn = (
  level: TraceEvent["level"],
  source: string,
  message: string,
  routeId?: string,
) => void;

export interface TraceLogger {
  trace: TraceFn;
  events(): TraceEvent[];
}

export function createTraceLogger(limit = 1000): TraceLogger {
  const traces: TraceEvent[] = [];

  return {
    trace(level, source, message, routeId) {
      traces.push({
        id: `trace-${Date.now()}-${traces.length}`,
        time: new Date().toISOString(),
        level,
        source,
        message,
        routeId,
      });
      while (traces.length > limit) traces.shift();
      console.log(`[router-daemon] ${level} ${source}: ${message}`);
    },
    events() {
      return traces.slice();
    },
  };
}
