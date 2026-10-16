export type EmailDeliveryMetricRow = {
  status: string;
  providerName: string | null;
  deliveryCount: number;
  attemptsTotal: number;
  activeRetries: number;
  unknownProviderOutcomes: number;
};

const providerOutcomeStatuses = new Set([
  "accepted_by_provider",
  "delivered",
  "bounced",
  "failed",
]);

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function providerLabel(value: string | null): string {
  if (!value) return "unknown";
  return /^[a-zA-Z0-9_.-]{1,40}$/.test(value) ? value : "other";
}

export function renderEmailMetrics(rows: EmailDeliveryMetricRow[]): string {
  const lines = [
    "# HELP ticketlive_email_delivery_records Current durable Email delivery rows.",
    "# TYPE ticketlive_email_delivery_records gauge",
    "# HELP ticketlive_email_delivery_attempts_total Total attempts recorded in the Email delivery store.",
    "# TYPE ticketlive_email_delivery_attempts_total counter",
    "# HELP ticketlive_email_active_retries Deliveries currently queued or sending after at least one provider attempt.",
    "# TYPE ticketlive_email_active_retries gauge",
    "# HELP ticketlive_email_provider_outcomes Current durable outcomes recorded for each provider.",
    "# TYPE ticketlive_email_provider_outcomes gauge",
    "# HELP ticketlive_email_unknown_provider_outcomes Number of provider outcomes still requiring reconciliation.",
    "# TYPE ticketlive_email_unknown_provider_outcomes gauge",
  ];
  const attemptsByProvider = new Map<string, number>();
  const activeRetriesByProvider = new Map<string, number>();
  const unknownOutcomesByProvider = new Map<string, number>();

  for (const row of rows) {
    const provider = escapeLabel(providerLabel(row.providerName));
    const status = escapeLabel(row.status);
    attemptsByProvider.set(provider, (attemptsByProvider.get(provider) ?? 0) + row.attemptsTotal);
    activeRetriesByProvider.set(provider, (activeRetriesByProvider.get(provider) ?? 0) + row.activeRetries);
    unknownOutcomesByProvider.set(
      provider,
      (unknownOutcomesByProvider.get(provider) ?? 0) + row.unknownProviderOutcomes,
    );
    lines.push(
      `ticketlive_email_delivery_records{provider="${provider}",status="${status}"} ${row.deliveryCount}`,
    );
    if (providerOutcomeStatuses.has(row.status)) {
      lines.push(
        `ticketlive_email_provider_outcomes{provider="${provider}",outcome="${status}"} ${row.deliveryCount}`,
      );
    }
  }

  for (const [provider, attempts] of attemptsByProvider) {
    lines.push(`ticketlive_email_delivery_attempts_total{provider="${provider}"} ${attempts}`);
  }
  for (const [provider, count] of activeRetriesByProvider) {
    lines.push(`ticketlive_email_active_retries{provider="${provider}"} ${count}`);
  }
  for (const [provider, count] of unknownOutcomesByProvider) {
    lines.push(`ticketlive_email_unknown_provider_outcomes{provider="${provider}"} ${count}`);
  }

  return `${lines.join("\n")}\n`;
}
