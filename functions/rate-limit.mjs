const asCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function utcWindowKeys(date) {
  const iso = date.toISOString();
  return {
    dayKey: iso.slice(0, 10).replaceAll("-", ""),
    hourKey: iso.slice(11, 13)
  };
}

export function secondsUntilNextUtcHour(date) {
  const next = new Date(date);
  next.setUTCMinutes(60, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - date.getTime()) / 1000));
}

export function secondsUntilNextUtcDay(date) {
  const next = new Date(date);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - date.getTime()) / 1000));
}

export function applyRateLimit(current, options) {
  const {
    uidKey,
    hourKey,
    nowMs,
    perUserHour,
    perUserDay,
    globalDay,
    retryAfterHour,
    retryAfterDay
  } = options;
  const state = current && typeof current === "object" ? structuredClone(current) : {};
  const users = state.users && typeof state.users === "object" ? state.users : {};
  const user = users[uidKey] && typeof users[uidKey] === "object"
    ? users[uidKey]
    : {};
  const hours = user.hours && typeof user.hours === "object" ? user.hours : {};

  const globalCount = asCount(state.globalCount);
  const dailyCount = asCount(user.dailyCount);
  const hourlyCount = asCount(hours[hourKey]);

  if (globalCount >= globalDay) {
    return { allowed: false, scope: "global-day", retryAfterSeconds: retryAfterDay };
  }
  if (dailyCount >= perUserDay) {
    return { allowed: false, scope: "user-day", retryAfterSeconds: retryAfterDay };
  }
  if (hourlyCount >= perUserHour) {
    return { allowed: false, scope: "user-hour", retryAfterSeconds: retryAfterHour };
  }

  hours[hourKey] = hourlyCount + 1;
  user.dailyCount = dailyCount + 1;
  user.hours = hours;
  users[uidKey] = user;
  state.globalCount = globalCount + 1;
  state.users = users;
  state.updatedAt = nowMs;

  return {
    allowed: true,
    state,
    remaining: {
      userHour: perUserHour - hourlyCount - 1,
      userDay: perUserDay - dailyCount - 1,
      globalDay: globalDay - globalCount - 1
    }
  };
}
