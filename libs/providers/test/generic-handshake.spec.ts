import { GenericAdapter } from '../src/generic.adapter';
import { validateGenericConfig } from '../src/generic-config';

/**
 * PK4 (SPEC-provider-khac §6.1/§6.3, E3/E13/E16/E20/E27, ADR-205): khuôn `handshake` + `ack` của GenericAdapter.
 */
const base = { scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'acme.event' };
const field = (extra: Record<string, unknown>) => {
  const r = validateGenericConfig({ ...base, ...extra });
  return r.ok ? null : (r as { field: string }).field;
};

describe('[PK:T12] (phần b) validateGenericConfig: handshake / ack sai khuôn -> đúng tên trường', () => {
  it.each([
    [{ handshake: 'x' }, 'handshake'],
    [{ handshake: { kind: 'callout' } }, 'handshake.kind'],
    [{ handshake: { kind: 'query-echo' } }, 'handshake.param'],
    [{ handshake: { kind: 'query-echo', param: 'a', verifyTokenParam: 'a' } }, 'handshake.verifyTokenParam'],
    [{ handshake: { kind: 'query-echo', param: 'a', verifyToken: 'plain-token-1' } }, 'handshake.verifyToken'],
    [{ handshake: { kind: 'query-echo', param: 'a', verifyTokenEnc: 'x' } }, 'handshake.verifyTokenEnc'],
    [{ handshake: { kind: 'body-echo', when: { field: 'type' }, echo: { field: 'c' } } }, 'handshake.when'],
    [{ handshake: { kind: 'body-echo', when: { field: 'type', header: 'x', equals: 'y' }, echo: { field: 'c' } } }, 'handshake.when'],
    [{ handshake: { kind: 'body-echo', when: { field: 'a.b', equals: 'y' }, echo: { field: 'c' } } }, 'handshake.when.field'],
    [{ handshake: { kind: 'body-echo', when: { header: 'X-Up', equals: 'y' }, echo: { field: 'c' } } }, 'handshake.when.header'],
    [{ handshake: { kind: 'body-echo', when: { field: 'type', equals: 'a b' }, echo: { field: 'c' } } }, 'handshake.when.equals'],
    [{ handshake: { kind: 'body-echo', when: { field: 'type', equals: 'v' }, echo: { field: 'a.b' } } }, 'handshake.echo.field'],
    [{ handshake: { kind: 'header-echo', header: 'x-hook-secret', adoptSecret: true } }, 'handshake.adoptSecret'],
    [{ handshake: { kind: 'header-echo', header: 'x-hook-secret', extra: 1 } }, 'handshake.extra'],
    [{ handshake: { kind: 'hmac-echo', when: { field: 'event', equals: 'v' }, tokenField: 'plainToken', macField: 'plainToken' } }, 'handshake.macField'],
    [{ handshake: { kind: 'manual-url', when: { field: 'Type', equals: 'SubscriptionConfirmation' } } }, 'handshake.urlField'],
    [{ ack: { rejectStatus: 200 } }, 'ack.rejectStatus'],
    [{ ack: { rejectStatus: 204 } }, 'ack.rejectStatus'],
    [{ ack: { successStatus: 201 } }, 'ack.successStatus'],
    [{ ack: { blockedStatus: 503 } }, 'ack.blockedStatus'],
  ])('%j -> %s', (extra, f) => {
    expect(field(extra)).toBe(f);
  });

  it('khuôn hợp lệ được giữ nguyên (cả signed-template), round-trip ổn định', () => {
    const ok = [
      { handshake: { kind: 'query-echo', param: 'hub.challenge', verifyTokenParam: 'hub.verify_token', verifyTokenEnc: 'enc' }, ack: { successStatus: 200, rejectStatus: 403 } },
      { handshake: { kind: 'body-echo', when: { header: 'twitch-eventsub-message-type', equals: 'webhook_callback_verification' }, echo: { field: 'challenge' } } },
      { handshake: { kind: 'header-echo', header: 'x-hook-secret' }, ack: { successStatus: 204 } },
      { handshake: { kind: 'hmac-echo', when: { field: 'event', equals: 'endpoint.url_validation' }, tokenParent: 'payload', tokenField: 'plainToken', macField: 'encryptedToken' } },
      { handshake: { kind: 'manual-url', when: { field: 'Type', equals: 'SubscriptionConfirmation' }, urlField: 'SubscribeURL' }, ack: { rejectStatus: 503 } },
    ];
    for (const extra of ok) {
      const r = validateGenericConfig({ ...base, ...extra });
      expect(r.ok).toBe(true);
      const c = (r as unknown as { config: Record<string, unknown> }).config;
      expect(c.handshake).toEqual(extra.handshake);
      if ('ack' in extra) expect(c.ack).toEqual(extra.ack);
      expect(validateGenericConfig(c)).toEqual(r);
    }
    const st = validateGenericConfig({
      scheme: 'signed-template', template: 'v0:{timestamp}:{body}', signature: { headers: ['x-slack-signature'], prefix: 'v0=' }, timestampHeader: 'x-slack-request-timestamp', toleranceSec: 300,
      idempotency: { field: 'event_id' }, eventType: 'slack.event', handshake: { kind: 'body-echo', when: { field: 'type', equals: 'url_verification' }, echo: { field: 'challenge' } }, ack: { rejectStatus: 401 },
    });
    expect(st.ok && (st as any).config.handshake.kind).toBe('body-echo');
    expect(st.ok && (st as any).config.ack).toEqual({ rejectStatus: 401 });
  });
});

describe('[PK:T11] (phần c) GenericAdapter.acceptsMethod / buildAck', () => {
  const a = new GenericAdapter();
  const qe = { verificationConfig: { ...base, handshake: { kind: 'query-echo', param: 'challenge' } } };
  const r = (query: string) => ({ provider: 'generic', sourceKey: 'k', headers: {}, rawBody: Buffer.alloc(0), query }) as any;

  it('POST luôn nhận; GET chỉ khi query-echo + đúng MỘT param; HEAD/PUT không bao giờ', () => {
    expect(a.acceptsMethod('POST', { verificationConfig: base })).toBe(true);
    expect(a.acceptsMethod('GET', { verificationConfig: base }, r('challenge=1'))).toBe(false);
    expect(a.acceptsMethod('GET', qe, r('challenge=1'))).toBe(true);
    expect(a.acceptsMethod('GET', qe, r(''))).toBe(false);
    expect(a.acceptsMethod('GET', qe, r('challenge=1&challenge=2'))).toBe(false);
    for (const m of ['HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) expect(a.acceptsMethod(m, qe, r('challenge=1'))).toBe(false);
  });

  it('buildAck: successStatus 204 -> body null; rejectStatus thay 401; 422 giữ nguyên; mặc định như cũ', () => {
    const ctx = { verificationConfig: { ...base, ack: { successStatus: 204, rejectStatus: 503 } } };
    expect(a.buildAck({ accepted: true, status: 200 }, ctx)).toEqual({ status: 204, body: null });
    expect(a.buildAck({ accepted: false, status: 401, message: 'x' }, ctx).status).toBe(503);
    expect(a.buildAck({ accepted: false, status: 422, message: 'x' }, ctx).status).toBe(422);
    expect(a.buildAck({ accepted: true, status: 200 }, { verificationConfig: base })).toEqual({ status: 200, body: { ok: true } });
    expect(a.buildAck({ accepted: false, status: 401, message: 'x' }).status).toBe(401);
  });

  it('header-echo: header được che trước khi lưu (sensitiveHeaders)', () => {
    expect(a.sensitiveHeaders({ verificationConfig: { ...base, handshake: { kind: 'header-echo', header: 'x-hook-secret' } } })).toContain('x-hook-secret');
  });
});
