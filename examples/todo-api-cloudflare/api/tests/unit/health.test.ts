import { describe, it, expect } from 'vitest';
import app from '../../src/index';

describe('Health endpoint', () => {
  it('should return 200 with ok status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('should include a requestId in the response body', async () => {
    const res = await app.request('/health');
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('should include X-Request-Id response header', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('X-Request-Id')).not.toBeNull();
  });
});
