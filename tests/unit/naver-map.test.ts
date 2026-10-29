import { afterEach, expect, it, vi } from 'vitest';
import { loadNaverMaps, naverMapsScriptUrl, type NaverMaps } from '../../src/web/naver-map';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads the current NAVER Maps SDK with the NCP key ID parameter', () => {
  const url = new URL(naverMapsScriptUrl('public-client-id'));
  expect(url.origin).toBe('https://oapi.map.naver.com');
  expect(url.pathname).toBe('/openapi/v3/maps.js');
  expect(url.searchParams.get('ncpKeyId')).toBe('public-client-id');
  expect(url.searchParams.get('callback')).toBe('__campusRideNaverMapsLoaded');
});

it('waits for the maps API when the SDK callback runs before it is attached', async () => {
  vi.useFakeTimers();
  const script = { remove: vi.fn() } as unknown as HTMLScriptElement;
  const fakeWindow = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    dispatchEvent: vi.fn(),
  } as unknown as Window;
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', {
    createElement: () => script,
    head: { appendChild: vi.fn() },
  });

  const maps = {} as NaverMaps;
  const loaded = loadNaverMaps('public-client-id');
  fakeWindow.__campusRideNaverMapsLoaded?.();
  setTimeout(() => { fakeWindow.naver = { maps }; }, 25);
  await vi.advanceTimersByTimeAsync(30);

  await expect(loaded).resolves.toBe(maps);
});
