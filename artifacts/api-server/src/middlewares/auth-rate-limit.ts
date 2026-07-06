/**
 * Auth Rate Limiter
 *
 * Applied only to /api/auth/* routes.
 * - 5 attempts per 15 minutes per IP address.
 * - Returns 429 with a message when the limit is hit.
 * - Logs a warning including the offending IP on every rejection.
 * - Fail-open: if the limiter itself throws (memory pressure, etc.) the
 *   request is allowed through rather than blocking legitimate users.
 *
 * /api/health and /api/healthz are NEVER affected — they are mounted on a
 * separate path and this middleware is not applied to them.
 */

/**
 * Auth Rate Limiters
 *
 * Previously: a single shared limiter of 5 requests / 15 min per IP covered
 * ALL /api/auth/* endpoints combined (register-request, verify-otp, login,
 * refresh, change-password, send-reset-otp, verify-reset-otp, reset-password,
 * devices, support-contact — 12 endpoints total). A single legitimate user
 * completing signup + one login retry could exhaust most of that budget by
 * themselves, and — critically — many real users can share one public IP
 * (mobile carrier-grade NAT is common), so one person's normal usage could
 * lock out everyone else behind that same IP for 15 minutes. That's the bug
 * that was reported.
 *
 * Fixed with two layers instead:
 *   1. `generalAuthRateLimiter` — a much more generous per-IP baseline
 *      (40 requests / 15 min) applied to the whole /api/auth prefix, purely
 *      as a safety net against gross abuse/scripted flooding — not something
 *      normal multi-step signup/login usage should ever realistically hit,
 *      even with several real users sharing one IP.
 *   2. `loginRateLimiter` — a second, additional limiter applied ONLY to
 *      POST /api/auth/login, keyed by the submitted email/phone (from the
 *      request body) rather than IP. This is what actually protects a
 *      specific account from brute-force password guessing, without
 *      punishing every other user on a shared IP for one account being
 *      targeted. Falls back to IP-keying only if no identifier is present
 *      in the body (malformed request).
 *
 * Both are fail-open: if the limiter itself throws (memory pressure, etc.)
 * the request is allowed through rather than blocking legitimate users.
 *
 * /api/health and /api/healthz are NEVER affected — mounted separately.
 */

import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

function makeFailOpen(
  limiter: ReturnType<typeof rateLimit>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      limiter(req, res, (err?: unknown) => {
        if (err) {
          logger.warn({ err }, "Rate limiter internal error — failing open");
          next();
          return;
        }
        next();
      });
    } catch (err) {
      logger.warn({ err }, "Rate limiter threw synchronously — failing open");
      next();
    }
  };
}

const _generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 40,                 // generous per-IP baseline across all auth endpoints combined
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    logger.warn({ ip, path: req.path, method: req.method }, "General auth rate limit triggered");
    res.status(429).json({
      error: "طلبات كثيرة جداً. يرجى المحاولة مجدداً بعد 15 دقيقة.",
      code: "RATE_LIMITED",
    });
  },
});

const _loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 8,                  // 8 login attempts per *account* (email/phone), not per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const body = req.body as { email?: string; phone?: string } | undefined;
    const identifier = body?.email?.trim().toLowerCase() || body?.phone?.trim();
    if (identifier) return `login:${identifier}`;
    // Malformed request with no identifier — fall back to IP so it's still bounded.
    return `login-ip:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
  },
  handler: (req: Request, res: Response) => {
    const body = req.body as { email?: string; phone?: string } | undefined;
    const identifier = body?.email || body?.phone || "unknown";
    logger.warn({ identifier, ip: req.ip, path: req.path }, "Per-account login rate limit triggered");
    res.status(429).json({
      error: "محاولات دخول كثيرة جداً لهذا الحساب. يرجى المحاولة مجدداً بعد 15 دقيقة أو استخدام «نسيت كلمة المرور».",
      code: "RATE_LIMITED_ACCOUNT",
    });
  },
});

/** Applied to the whole /api/auth router as a baseline. */
export const authRateLimiter = makeFailOpen(_generalLimiter);

/** Applied additionally, only to POST /api/auth/login. */
export const loginRateLimiter = makeFailOpen(_loginLimiter);
