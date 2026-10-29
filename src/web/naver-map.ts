export type NaverLatLng = object;
export type NaverMap = { setCenter: (center: NaverLatLng) => void };
export type NaverOverlay = { setMap: (map: NaverMap | null) => void };

export type NaverMaps = {
  LatLng: new (lat: number, lng: number) => NaverLatLng;
  Map: new (element: HTMLElement, options: { center: NaverLatLng; zoom: number }) => NaverMap;
  Marker: new (options: { map: NaverMap; position: NaverLatLng; title: string; zIndex?: number }) => NaverOverlay;
  Circle: new (options: {
    map: NaverMap; center: NaverLatLng; radius: number; fillColor: string; fillOpacity: number;
    strokeColor: string; strokeOpacity: number; strokeWeight: number; clickable: boolean;
  }) => NaverOverlay;
};

declare global {
  interface Window {
    naver?: { maps: NaverMaps };
    navermap_authFailure?: () => void;
    __campusRideNaverMapsLoaded?: () => void;
  }
}

const callbackName = '__campusRideNaverMapsLoaded';
let loadingClientId: string | undefined;
let mapsPromise: Promise<NaverMaps> | undefined;

export function naverMapsScriptUrl(clientId: string) {
  const url = new URL('https://oapi.map.naver.com/openapi/v3/maps.js');
  url.searchParams.set('ncpKeyId', clientId);
  url.searchParams.set('callback', callbackName);
  return url.toString();
}

export function loadNaverMaps(clientId: string): Promise<NaverMaps> {
  if (window.naver?.maps) return Promise.resolve(window.naver.maps);
  if (mapsPromise) {
    return loadingClientId === clientId
      ? mapsPromise
      : Promise.reject(new Error('NAVER Maps is already loading with a different client ID.'));
  }

  loadingClientId = clientId;
  mapsPromise = new Promise<NaverMaps>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      delete window[callbackName];
      if (error) {
        script.remove();
        reject(error);
      } else if (window.naver?.maps) {
        resolve(window.naver.maps);
      } else {
        reject(new Error('NAVER Maps SDK loaded without its maps API.'));
      }
    };
    const timeout = window.setTimeout(() => finish(new Error('NAVER Maps SDK load timed out.')), 20_000);

    window[callbackName] = () => {
      const waitForMaps = () => {
        if (settled) return;
        if (window.naver?.maps) finish();
        else window.setTimeout(waitForMaps, 10);
      };
      waitForMaps();
    };
    window.navermap_authFailure = () => window.dispatchEvent(new Event('naver-map-auth-failure'));
    script.async = true;
    script.referrerPolicy = 'strict-origin';
    script.src = naverMapsScriptUrl(clientId);
    script.onerror = () => finish(new Error('NAVER Maps SDK could not be loaded.'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    mapsPromise = undefined;
    loadingClientId = undefined;
    throw error;
  });

  return mapsPromise;
}
