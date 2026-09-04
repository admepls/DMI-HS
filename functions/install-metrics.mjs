const asCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

const operationField = (operation) =>
  operation === "full-install" ? "fullInstall" : "firmwareUpdate";

function counterGroup(value) {
  return value && typeof value === "object" ? value : {};
}

function incrementCounters(value, operation, nowMs) {
  const group = counterGroup(value);
  const field = operationField(operation);
  group.total = asCount(group.total) + 1;
  group[field] = asCount(group[field]) + 1;
  group.updatedAtMs = nowMs;
  return group;
}

export function safeVersionKey(version) {
  const normalized = String(version || "unknown")
    .trim()
    .replace(/[.#$[\]\/]/g, "_")
    .slice(0, 100);
  return normalized || "unknown";
}

export function installMetricCounts(state) {
  const totals = counterGroup(state?.totals);
  return {
    fullInstall: asCount(totals.fullInstall),
    firmwareUpdate: asCount(totals.firmwareUpdate),
    total: asCount(totals.total)
  };
}

export function applySuccessfulInstall(current, options) {
  const {
    grantDayKey,
    successDayKey,
    grantId,
    uidKey,
    attemptId,
    operation,
    nowMs,
    maxSuccessesPerGrant
  } = options;
  const state = current && typeof current === "object"
    ? structuredClone(current)
    : {};
  const grant = state.grants?.[grantDayKey]?.[grantId];

  if (!grant || typeof grant !== "object") {
    return { accepted: false, reason: "grant-not-found" };
  }
  if (grant.uidKey !== uidKey) {
    return { accepted: false, reason: "grant-owner-mismatch" };
  }
  if (!Number.isSafeInteger(grant.reportByMs) || grant.reportByMs < nowMs) {
    return { accepted: false, reason: "grant-expired" };
  }

  const attempts = grant.attempts && typeof grant.attempts === "object"
    ? grant.attempts
    : {};
  if (attempts[attemptId]) {
    return {
      accepted: true,
      duplicate: true,
      state,
      counts: installMetricCounts(state)
    };
  }

  const successCount = asCount(grant.successCount);
  if (successCount >= maxSuccessesPerGrant) {
    return { accepted: false, reason: "grant-limit" };
  }

  const day = counterGroup(state.daily?.[successDayKey]);
  const versionKey = safeVersionKey(grant.version);
  const version = counterGroup(state.versions?.[versionKey]);
  const totals = incrementCounters(state.totals, operation, nowMs);
  incrementCounters(day, operation, nowMs);
  incrementCounters(version, operation, nowMs);
  version.label = String(grant.version || "unknown");

  state.totals = totals;
  state.daily = counterGroup(state.daily);
  state.daily[successDayKey] = day;
  state.versions = counterGroup(state.versions);
  state.versions[versionKey] = version;
  grant.attempts = attempts;
  grant.attempts[attemptId] = { operation, recordedAtMs: nowMs };
  grant.successCount = successCount + 1;
  grant.lastSuccessAtMs = nowMs;

  return {
    accepted: true,
    duplicate: false,
    state,
    counts: installMetricCounts(state)
  };
}
