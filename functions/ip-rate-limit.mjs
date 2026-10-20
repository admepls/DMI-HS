import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { secondsUntilNextUtcDay, secondsUntilNextUtcHour, utcWindowKeys } from "./rate-limit.mjs";

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// IPv4-mapped IPv6 must share the IPv4 bucket. Group other IPv6 addresses by
// /64 so rotating a device's address within its subnet cannot reset the limit.
export function canonicalIpNetwork(value) {
  if (typeof value !== "string" || value.includes("%")) return null;
  const ip = value.trim();
  if (isIP(ip) === 4) return `v4:${ip}`;
  if (isIP(ip) !== 6) return null;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [start, end] = canonical.split("::");
  const left = start ? start.split(":") : [];
  const right = end ? end.split(":") : [];
  const groups = end === undefined ? left : [
    ...left, ...Array(8 - left.length - right.length).fill("0"), ...right
  ];
  const words = groups.map((part) => Number.parseInt(part, 16));
  if (words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff) {
    return `v4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  }
  return `v6:${words.slice(0, 4).map((part) => part.toString(16)).join(":")}/64`;
}

export function requestIpKey(rawRequest, dayKey, { trustedHops = 1, emulator = false } = {}) {
  // The Functions Framework trusts ALL proxy hops for request.ip. Do not use
  // it, X-Real-IP, CF-Connecting-IP, or an IP supplied in callable data.
  // This deployment calls Google's function endpoint directly. Read the
  // platform-appended suffix, not a caller-controlled XFF prefix. If an extra
  // trusted ingress is added, verify EVERY entry path before changing hops.
  if (!Number.isInteger(trustedHops) || trustedHops < 1 || trustedHops > 5) return null;
  const forwarded = rawRequest?.headers?.["x-forwarded-for"];
  let address;
  if (typeof forwarded === "string" && forwarded.length <= 2048) {
    const chain = forwarded.split(",");
    if (chain.length < trustedHops) return null;
    address = chain[chain.length - trustedHops];
  } else if (forwarded === undefined && emulator) {
    address = rawRequest?.socket?.remoteAddress;
  } else {
    return null;
  }
  const network = canonicalIpNetwork(address);
  if (!network) return null;
  // Store a daily pseudonymous key, never the raw IP. This is not encryption.
  return createHash("sha256").update(`installer-ip-v1|${dayKey}|${network}`).digest("hex");
}

export function applyIpRequestLimit(current, options) {
  const { ipKey, now, perIpMinute, perIpHour, perIpDay, globalDay } = options;
  const state = current && typeof current === "object" ? structuredClone(current) : {};
  const ips = state.ips && typeof state.ips === "object" ? state.ips : {};
  const ip = ips[ipKey] && typeof ips[ipKey] === "object" ? ips[ipKey] : {};
  const nowMs = now.getTime();
  const minute = Math.floor(nowMs / 60_000);
  const hour = Math.floor(nowMs / 3_600_000);
  // A delayed transaction from the previous window must not reset a newer one.
  const minuteCount = minute > count(ip.minute) ? 0 : count(ip.minuteCount);
  const hourCount = hour > count(ip.hour) ? 0 : count(ip.hourCount);
  const dayCount = count(ip.dayCount);
  const globalCount = count(state.globalCount);
  const deny = (scope, retryAfterSeconds) => ({ allowed: false, scope, retryAfterSeconds });
  if (globalCount >= globalDay) return deny("request-global-day", secondsUntilNextUtcDay(now));
  if (dayCount >= perIpDay) return deny("ip-day", secondsUntilNextUtcDay(now));
  if (hourCount >= perIpHour) return deny("ip-hour", secondsUntilNextUtcHour(now));
  if (minuteCount >= perIpMinute) return deny("ip-minute", Math.max(1, Math.ceil((60_000 - nowMs % 60_000) / 1000)));
  ips[ipKey] = {
    minute: Math.max(minute, count(ip.minute)), minuteCount: minuteCount + 1,
    hour: Math.max(hour, count(ip.hour)), hourCount: hourCount + 1,
    dayCount: dayCount + 1
  };
  return { allowed: true, state: { ...state, ips, globalCount: globalCount + 1, updatedAt: nowMs } };
}

export class IpLimitError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function createIpRequestGuard({
  transact, limits, clock = () => new Date(), identity = {}, ErrorType = IpLimitError,
  maxCacheEntries = 2048, onBackendError = () => {}
}) {
  // Cache DENIALS only. Successful admissions always use the shared atomic
  // transaction, so two instances/cold starts do not multiply the allowance.
  const blocked = new Map();
  let backendRetryAt = 0;
  function remember(key, decision, nowMs) {
    if (blocked.size >= maxCacheEntries) blocked.delete(blocked.keys().next().value);
    blocked.set(key, { ...decision, until: nowMs + decision.retryAfterSeconds * 1000 });
  }
  function reject(decision) {
    throw new ErrorType("resource-exhausted", "Too many installer requests. Please try again later.", {
      scope: decision.scope, retryable: true, retryAfterSeconds: decision.retryAfterSeconds
    });
  }
  return async (request) => {
    const now = clock();
    const nowMs = now.getTime();
    const { dayKey } = utcWindowKeys(now);
    const ipKey = requestIpKey(request.rawRequest, dayKey, identity);
    if (!ipKey) {
      throw new ErrorType("failed-precondition", "Your network address could not be verified. Reload the official installer or contact the operator.");
    }
    for (const [key, cached] of blocked) {
      if (cached.until <= nowMs) blocked.delete(key);
    }
    for (const key of [`global:${dayKey}`, `${dayKey}:${ipKey}`]) {
      const cached = blocked.get(key);
      if (cached) reject({ ...cached, retryAfterSeconds: Math.max(1, Math.ceil((cached.until - nowMs) / 1000)) });
    }
    if (backendRetryAt > nowMs) {
      throw new ErrorType("unavailable", "Installer protection is temporarily unavailable. Try again shortly.");
    }
    let decision;
    let result;
    try {
      result = await transact(dayKey, (current) => {
        decision = applyIpRequestLimit(current, { ...limits, ipKey, now });
        return decision.allowed ? decision.state : undefined;
      });
    } catch {
      backendRetryAt = nowMs + 10_000;
      onBackendError();
      throw new ErrorType("unavailable", "Installer protection is temporarily unavailable. Try again shortly.");
    }
    if (!decision || (decision.allowed && !result.committed)) {
      throw new ErrorType("unavailable", "Installer protection could not confirm this request. Try again shortly.");
    }
    if (!decision.allowed) {
      remember(decision.scope === "request-global-day" ? `global:${dayKey}` : `${dayKey}:${ipKey}`, decision, nowMs);
      reject(decision);
    }
    return { dayKey, ipKey, now };
  };
}

export function withIpRequestLimit(guard, handler) {
  return async (request) => {
    const network = await guard(request);
    return handler(request, network);
  };
}
