const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const processStartTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();

type HttpObservation = {
  method: string;
  route: string;
  statusCode: number;
  seconds: number;
};

const series = new Map<string, {
  method: string;
  route: string;
  status: string;
  count: number;
  sum: number;
  buckets: number[];
}>();

export function observeHttpRequest(observation: HttpObservation): void {
  const status = `${Math.floor(observation.statusCode / 100)}xx`;
  const key = JSON.stringify([observation.method, observation.route, status]);
  const current = series.get(key) ?? {
    method: observation.method,
    route: observation.route,
    status,
    count: 0,
    sum: 0,
    buckets: durationBuckets.map(() => 0),
  };
  current.count += 1;
  current.sum += observation.seconds;
  durationBuckets.forEach((bucket, index) => {
    if (observation.seconds <= bucket) current.buckets[index] = (current.buckets[index] ?? 0) + 1;
  });
  series.set(key, current);
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

export function renderHttpMetrics(
  outbox?: { pending: number; oldestAgeSeconds: number },
  domain?: {
    orders?: { unresolved: number; oldestUnresolvedAgeSeconds: number };
    holds?: { active: number; oldestAgeSeconds: number; capacityConflictsTotal: number; expiredTotal: number };
    paymentHoldMismatchTotal?: number;
  },
): string {
  const lines = [
    "# HELP http_server_request_duration_seconds HTTP server request duration.",
    "# TYPE http_server_request_duration_seconds histogram",
    "# HELP http_server_requests_total Completed HTTP server requests.",
    "# TYPE http_server_requests_total counter",
  ];

  for (const values of series.values()) {
    const labels = `method="${label(values.method)}",route="${label(values.route)}",status_class="${label(values.status)}"`;
    durationBuckets.forEach((bucket, index) => {
      lines.push(`http_server_request_duration_seconds_bucket{${labels},le="${bucket}"} ${values.buckets[index]}`);
    });
    lines.push(`http_server_request_duration_seconds_bucket{${labels},le="+Inf"} ${values.count}`);
    lines.push(`http_server_request_duration_seconds_sum{${labels}} ${values.sum}`);
    lines.push(`http_server_request_duration_seconds_count{${labels}} ${values.count}`);
    lines.push(`http_server_requests_total{${labels}} ${values.count}`);
  }

  if (outbox) {
    lines.push(
      "# HELP ticketlive_outbox_pending_total Number of unpublished outbox rows.",
      "# TYPE ticketlive_outbox_pending_total gauge",
      `ticketlive_outbox_pending_total ${outbox.pending}`,
      "# HELP ticketlive_outbox_oldest_age_seconds Age of the oldest unpublished outbox row.",
      "# TYPE ticketlive_outbox_oldest_age_seconds gauge",
      `ticketlive_outbox_oldest_age_seconds ${outbox.oldestAgeSeconds}`,
    );
  }

  if (domain?.holds) {
    lines.push(
      "# HELP ticketlive_holds_active_total Number of currently active inventory holds.",
      "# TYPE ticketlive_holds_active_total gauge",
      `ticketlive_holds_active_total ${domain.holds.active}`,
      "# HELP ticketlive_holds_oldest_active_age_seconds Age of the oldest active inventory hold.",
      "# TYPE ticketlive_holds_oldest_active_age_seconds gauge",
      `ticketlive_holds_oldest_active_age_seconds ${domain.holds.oldestAgeSeconds}`,
      "# HELP ticketlive_inventory_hold_capacity_conflicts_total Requests rejected because event capacity was insufficient.",
      "# TYPE ticketlive_inventory_hold_capacity_conflicts_total counter",
      `ticketlive_inventory_hold_capacity_conflicts_total ${domain.holds.capacityConflictsTotal}`,
      "# HELP ticketlive_inventory_holds_expired_total Inventory holds that have expired.",
      "# TYPE ticketlive_inventory_holds_expired_total counter",
      `ticketlive_inventory_holds_expired_total ${domain.holds.expiredTotal}`,
    );
  }

  if (domain?.orders) {
    lines.push(
      "# HELP ticketlive_orders_unresolved_total Orders in a nonterminal or reconciliation state.",
      "# TYPE ticketlive_orders_unresolved_total gauge",
      `ticketlive_orders_unresolved_total ${domain.orders.unresolved}`,
      "# HELP ticketlive_orders_oldest_unresolved_age_seconds Age of the oldest unresolved Order state.",
      "# TYPE ticketlive_orders_oldest_unresolved_age_seconds gauge",
      `ticketlive_orders_oldest_unresolved_age_seconds ${domain.orders.oldestUnresolvedAgeSeconds}`,
    );
  }

  if (domain?.paymentHoldMismatchTotal !== undefined) {
    lines.push(
      "# HELP ticketlive_payment_hold_mismatch_total Order and Event inventory reconciliation mismatches observed.",
      "# TYPE ticketlive_payment_hold_mismatch_total counter",
      `ticketlive_payment_hold_mismatch_total ${domain.paymentHoldMismatchTotal}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function getOtlpMetricSnapshot(outbox?: { pending: number; oldestAgeSeconds: number }) {
  return {
    processStartTimeUnixNano,
    timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
    httpSeries: [...series.values()].map((value) => ({
      method: value.method,
      route: value.route,
      status: value.status,
      count: value.count,
      sum: value.sum,
      bucketCounts: value.buckets,
    })),
    outbox,
  };
}
