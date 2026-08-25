import {
  describe,
  expect,
  it,
  jest,
  afterEach,
  beforeEach,
} from '@jest/globals';
import {
  AuthKeyCredentialsProvider,
  type AuthKeyCredentialsProviderOptions,
  type IamJWTKeyCredentials,
} from './auth-key-credentials-provider.js';

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5gw6/xmAX10E/
flvzGshLm7wS0WXoC8+Y15SQkOm/W0b2jFqV2hllYBNEDl0KOCx6QR2BKCI47iGh
vX39dIgn6liTKfTfQFWaKTyDK0E2f4YfTNz9hNVF1eLTh3WsAhTnj004P6rJlMR5
9Au7/2J8l+7keDgQz17tgA6vEBQ4mEXhofeB4ykEp0fmzdLDawMrEeBjOR8S4UMH
hwbOKLuuaOojtkSQVZLxmVaAHyCA7Ju7N8PV1HPfnrxradKXQ7cqobHT4jnowqoj
TQ7TbTozckym01MTX2J8Jtk3r/q1EoR/bWyfSvVXUN0pr50KU4myrtE9fo2nKmvU
gWIFvPoJAgMBAAECggEACLz6od/nQNg705DRJfdZ/e29Aynn4fFEew+UiOa6i+/x
vMVJswtN7O+EmM0QZt3UgoG0sRPB4OqenO6/E4Q8sZyhRXVRen6eSZ+toQQVk0qY
d7r4Idzy6tIzWAFmco66i1m9qmudUNd4FcKAFv/llLbXYt2izm/mKcvBZU+dlDjL
WXnDnsf/IvntBqyJI0LbPQ0ClmlzeISuZ88ZMNiG8f5iABBDoCLL/JD8PkMaIb9s
AFWOURS+u+W5XwzdT5Or7L44AUIDmzjdCg06rhAXzRJmOQoVeLq/Pt0pUkXtYqss
DmGRof66MUvkwCvCyLA5PmFtu8LaY/w2qLOopoIc8QKBgQDwFxlMc3UrOUUjIa9y
DFygVcxD1bVzLBADKAlyUcdJGRtrmk+G5poN71WnFS8cienwyES/es0x+jntkLKH
POM9xOPSN/w5gyJsNUyEi2v81MKPCH6L47zxnGIG/8hpQFl9pVUZw3Th85eazUzd
TS5aHsJmz3DUmQivNM39eE1qHQKBgQDFzhchmUiY9K0xkvu6tZBgWln1f/5qTswI
BYNNVoF5q/91ix7zXhEXbigV+soq3upOwLs8Mk4tMZEnBqYD6kJUYIFbTHOSVNXf
+pXAKRdklNJ2mGr14+cbkrHQsIt2iahMTNDr0JxsyM5m7U1bcO700H0IjwKuSbUM
E4Z/0nOr3QKBgEa8t4Jz3givJfSU3yk+BShkPvuZgo19ZPZZHHdnKs0ZrZ+FZnr7
hFYotta0gh3pcFi12LOFzeE0tU6OPFtmEBnJ4cm1HwYe4cx546KFpXpngS89NHOo
1KlnBubDA9wmzncbeDhQAybzay574HKvY8G/oE1EPx0UPZ/JcguFH2HtAoGBALoI
sz6ZUGryq7UVPQWD346PS04Wm+vVwhTFQpFJC6qoNjGRr4FJ9h8oLjFF1j/tuUZq
A26BDX95v7+JhDfoaYu7281HIOb+PMxTe+Xnf6XMRgjeHrK2LlSDahMRB4lrvEpO
cKtoXsX9MgohowCePU8oin+zKN1MWydJcdTj1IBNAoGBAIyaRAZ0szIoAVrZ4k/9
6dnOUv1shMkWokQ42dt9PkscFnIjdXZujGDV7Rlk5B+r8yFnQKKq446D3ebQiEKD
u0L/sfyIZ3w+ucgffya07LEJwKMsDi/+GE7aYutmQtFPlt21NtAOyDCLcG9piZza
z0thcu5YY+GzrDxTH4TV4nPD
-----END PRIVATE KEY-----`;

const CREDENTIALS: IamJWTKeyCredentials = {
  keyId: 'test-key-id',
  serviceAccountId: 'test-service-account',
  privateKey: TEST_PRIVATE_KEY,
};

const originalFetch = globalThis.fetch;

function makeProvider(
  options: AuthKeyCredentialsProviderOptions,
): AuthKeyCredentialsProvider {
  return new AuthKeyCredentialsProvider(CREDENTIALS, options);
}

function okJsonResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function httpErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Ошибка, с которой отклоняется fetch-промис при abort сигнала. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown =
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError');
  const name =
    typeof (reason as { name?: unknown })?.name === 'string'
      ? (reason as { name: string }).name
      : 'AbortError';
  const error = new Error(
    reason instanceof Error ? reason.message : String(reason),
  );
  error.name = name;
  return error;
}

/** Mock fetch, который отклоняется сразу, как только сигнал abort-нула. */
function abortAwareFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('expected an abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        signal.addEventListener('abort', () => reject(abortError(signal)), {
          once: true,
        });
      }),
  );
}

function setFetchMock(mock: jest.Mock): void {
  (globalThis as { fetch: unknown }).fetch = mock;
}

describe('AuthKeyCredentialsProvider (#97)', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    // Провайдер делегирует @ycforge/auth, который логирует через console.*.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    debugSpy.mockRestore();
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  function allLogs(): string {
    return [warnSpy, errorSpy, logSpy, debugSpy]
      .flatMap((spy) => spy.mock.calls)
      .map((c) => c.map((a) => String(a)).join(' '))
      .join('\n');
  }

  it('keeps normal successful caching and refresh behavior', async () => {
    const fetchMock = jest.fn(() =>
      okJsonResponse({
        iamToken: 'tok-cached',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    expect(await provider.getToken()).toBe('tok-cached');
    expect(await provider.getToken()).toBe('tok-cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on invalid string expiresAt instead of poisoning the cache', async () => {
    const fetchMock = jest.fn(() =>
      okJsonResponse({ iamToken: 'tok-bad', expiresAt: 'not-a-date' }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    await expect(provider.getToken()).rejects.toThrow(/Invalid timestamp/);
    // Детерминированная ошибка — без ретраев и без шторма на IAM API.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects NaN and negative numeric expiresAt', async () => {
    const fetchMock = jest.fn(() =>
      okJsonResponse({ iamToken: 'tok-num', expiresAt: NaN }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    await expect(provider.getToken()).rejects.toThrow(
      /Invalid numeric timestamp/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns and falls back to a default TTL when expiresAt is missing', async () => {
    const fetchMock = jest.fn(() => okJsonResponse({ iamToken: 'tok-ns' }));
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    expect(await provider.getToken()).toBe('tok-ns');
    expect(await provider.getToken()).toBe('tok-ns');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnMessages).toContain('missing expiresAt');
    expect(warnMessages).toContain('default token TTL');
  });

  it('interprets milliseconds-scale numeric expiresAt as milliseconds (#97)', async () => {
    const expiresAtMs = Date.now() + 3600_000;
    const fetchMock = jest.fn(() =>
      okJsonResponse({ iamToken: 'tok-ms', expiresAt: expiresAtMs }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    expect(await provider.getToken()).toBe('tok-ms');
    expect(await provider.getToken()).toBe('tok-ms');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('interprets seconds-like numeric expiresAt as seconds, not 1970 (#97)', async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = jest.fn(() =>
      okJsonResponse({ iamToken: 'tok-s', expiresAt: expiresAtSeconds }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    expect(await provider.getToken()).toBe('tok-s');
    expect(await provider.getToken()).toBe('tok-s');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the IAM fetch after the configured timeout (#97)', async () => {
    setFetchMock(abortAwareFetch());

    const provider = makeProvider({
      fetchTimeoutMs: 30,
      retry: { attempts: 1 },
    });

    await expect(provider.getToken()).rejects.toThrow(/timed out after 30 ms/);
  });

  it('forwards an external abort signal to the IAM fetch (#97)', async () => {
    setFetchMock(abortAwareFetch());

    const provider = makeProvider({
      fetchTimeoutMs: 60_000,
      retry: { attempts: 1 },
    });
    const controller = new AbortController();

    const pending = provider.getToken(false, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('invalidates the stale cached token after a failed force refresh (#97)', async () => {
    const first = jest.fn(() =>
      okJsonResponse({
        iamToken: 'stale-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    setFetchMock(first);

    const provider = makeProvider({
      fetchTimeoutMs: 60_000,
      retry: { attempts: 1 },
    });
    await expect(provider.getToken()).resolves.toBe('stale-token');

    const failing = jest.fn(() => Promise.reject(new Error('IAM is down')));
    setFetchMock(failing);

    await expect(provider.getToken(true)).rejects.toThrow('IAM is down');

    // Кеш обязан быть очищен: следующий вызов должен снова сходить в IAM,
    // а не вернуть устаревший токен.
    const fresh = jest.fn(() =>
      okJsonResponse({
        iamToken: 'fresh-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    setFetchMock(fresh);

    await expect(provider.getToken()).resolves.toBe('fresh-token');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does not log the IAM response body on HTTP errors (#97)', async () => {
    const secretBody = 'super-secret-body-content';
    const fetchMock = jest.fn(() => httpErrorResponse(500, secretBody));
    setFetchMock(fetchMock);

    const provider = makeProvider({
      fetchTimeoutMs: 60_000,
      retry: { attempts: 2, baseDelayMs: 1, factor: 1 },
    });

    await expect(provider.getToken()).rejects.toThrow(/status 500/);

    const logs = allLogs();
    expect(logs).toContain('IAM token exchange failed with status 500');
    expect(logs).not.toContain(secretBody);
  });

  it('logs retry attempts with the error message, without the response body (#97)', async () => {
    const fetchMock = jest.fn(() => httpErrorResponse(500, 'body'));
    setFetchMock(fetchMock);

    const provider = makeProvider({
      fetchTimeoutMs: 60_000,
      retry: { attempts: 3, baseDelayMs: 1, factor: 1 },
    });

    await expect(provider.getToken()).rejects.toThrow(/status 500/);

    // Две неудачные попытки до последней → два предупреждения о ретрае.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnMessages).toContain('IAM token exchange attempt 1 failed');
    expect(warnMessages).toContain('IAM token exchange failed with status 500');
  });

  it('does not log the IAM payload or token material (#97)', async () => {
    const token = 'SUPER_SECRET_IAM_TOKEN_VALUE';
    const fetchMock = jest.fn(() =>
      okJsonResponse({
        iamToken: token,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    await provider.getToken();

    expect(allLogs()).not.toContain(token);
  });

  it('does not expose the payload when iamToken is missing (#97)', async () => {
    const fetchMock = jest.fn(() =>
      okJsonResponse({
        expiresAt: '2026-01-01T00:00:00.000Z',
        extraField: 'sensitive-extra',
      }),
    );
    setFetchMock(fetchMock);

    const provider = makeProvider({ fetchTimeoutMs: 60_000 });

    await expect(provider.getToken()).rejects.toThrow(/no iamToken/);

    const logs = allLogs();
    expect(logs).not.toContain('2026-01-01');
    expect(logs).not.toContain('sensitive-extra');
  });

  it('rejects non-positive fetchTimeoutMs at construction (#97)', () => {
    expect(
      () => new AuthKeyCredentialsProvider(CREDENTIALS, { fetchTimeoutMs: 0 }),
    ).toThrow(/positive number/);
  });
});
