import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthConfig } from './auth-config';

/**
 * SPEC-auth §4, §5.3, §5.7. Mọi verify GHIM `algorithms:['HS256']` + `iss` + `aud`: token `alg:none`, ký bằng
 * khoá khác, token socket dùng làm token console (hay ngược lại) đều bị từ chối (UA6, UA29).
 */
export const TOKEN_ISSUER = 'webhook-hub';
export const ACCESS_AUDIENCE = 'console';
export const SOCKET_AUDIENCE = 'socket';
export const SOCKET_TICKET_TTL_S = 60;

export interface AccessClaims {
  sub: string;
  sid: string;
}

export interface SocketTicketClaims extends AccessClaims {
  tid: string;
}

export function signAccessToken(jwt: JwtService, cfg: AuthConfig, c: { userId: string; sessionId: string }): string {
  return jwt.sign(
    { sub: c.userId, sid: c.sessionId },
    { secret: cfg.jwtSecret, algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: ACCESS_AUDIENCE, expiresIn: cfg.accessTtlS },
  );
}

export function verifyAccessToken(jwt: JwtService, cfg: AuthConfig, token: string): AccessClaims | null {
  try {
    const p = jwt.verify<AccessClaims>(token, { secret: cfg.jwtSecret, algorithms: ['HS256'], issuer: TOKEN_ISSUER, audience: ACCESS_AUDIENCE });
    return typeof p?.sub === 'string' && typeof p?.sid === 'string' ? { sub: p.sub, sid: p.sid } : null;
  } catch {
    return null;
  }
}

/** Vé socket (§5.7): JWT 60 giây, khoá RIÊNG `SOCKET_TICKET_SECRET`, `aud:'socket'`. */
export function signSocketTicket(jwt: JwtService, cfg: AuthConfig, c: { userId: string; sessionId: string; projectId: string }): string {
  return jwt.sign(
    { sub: c.userId, sid: c.sessionId, tid: c.projectId },
    { secret: cfg.socketTicketSecret, algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: SOCKET_AUDIENCE, expiresIn: SOCKET_TICKET_TTL_S },
  );
}

export function verifySocketTicket(jwt: JwtService, cfg: AuthConfig, ticket: string): SocketTicketClaims | null {
  try {
    const p = jwt.verify<SocketTicketClaims>(ticket, {
      secret: cfg.socketTicketSecret,
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: SOCKET_AUDIENCE,
    });
    return typeof p?.sub === 'string' && typeof p?.sid === 'string' && typeof p?.tid === 'string' ? { sub: p.sub, sid: p.sid, tid: p.tid } : null;
  } catch {
    return null;
  }
}

/** Refresh token / token trong mail: 32 byte ngẫu nhiên base64url; DB chỉ giữ sha256 (hex). */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
