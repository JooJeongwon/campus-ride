import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { healthResponse } from '../shared/api';
import { devLoginSchema, driverProfileDecisionSchema, driverProfileSchema, profileUpdateSchema, verificationDecisionSchema } from '../shared/auth';
import { adminRouteCreateSchema, adminRouteUpdateSchema, adminStopSchema } from '../shared/admin';
import { reportCreateSchema, suspendUserSchema } from '../shared/moderation';
import { isLocationFresh, projectVirtualMap } from './location-map';
import { loadNaverMaps, type NaverMap, type NaverOverlay, type NaverMaps } from './naver-map';
import { rideRequestCreateSchema, tripCreateSchema, tripSearchResponseSchema, tripSearchSchema, type TripMatch, type TripSearchInput } from '../shared/trips';
import './style.css';

function seoulDateTimeInput(timestamp: number) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp)).replace(' ', 'T');
}

function locationFreshness(receivedAt: number) {
  return Date.now() - receivedAt > 30_000 ? '위치 갱신 중단' : `${new Date(receivedAt).toLocaleTimeString('ko-KR')}에 갱신`;
}

type ConsentKind = 'TERMS' | 'PRIVACY' | 'LOCATION_COLLECTION' | 'LOCATION_SHARING';
type ConsentState = { version: string; url: string | null; accepted: boolean };
type LocationPoint = {
  key: string; nickname: string; role: 'DRIVER' | 'RIDER'; lat: number; lng: number; accuracyM: number;
  capturedAt: number; receivedAt: number; expiresAt: number; sequence: number;
};
type LocationDisclosure = {
  id: string; recipientNickname: string; recipientRole: 'DRIVER' | 'RIDER'; purpose: 'MEETING'; requestedAt: number;
  providedAt: number | null; noticeAcknowledgedAt: number | null; postNoticeAcknowledgedAt: number | null;
};

function VirtualLocationMap({
  stop,
  own,
  shared,
}: {
  stop: { name: string; lat: number; lng: number };
  own: Omit<LocationPoint, 'nickname' | 'role' | 'key'> | null;
  shared: LocationPoint[];
}) {
  const markers = [
    ...(own && isLocationFresh(own.receivedAt) ? [{
      id: 'self', label: '내 위치', kind: 'self' as const,
      lat: own.lat, lng: own.lng, accuracyM: own.accuracyM,
    }] : []),
    ...shared.filter((point) => isLocationFresh(point.receivedAt)).map((point) => ({
      id: point.key,
      label: point.role === 'DRIVER' ? '운전자 위치' : `${point.nickname} 위치`,
      kind: 'peer' as const, lat: point.lat, lng: point.lng, accuracyM: point.accuracyM,
    })),
  ];
  const points = projectVirtualMap(stop, markers);

  return <figure className="virtual-map">
    <svg viewBox="0 0 320 220" role="img" aria-labelledby="virtual-map-title" aria-describedby="virtual-map-description">
      <title id="virtual-map-title">가상 위치도</title>
      <desc id="virtual-map-description">지정 승차 지점과 30초 이내에 갱신된 위치 및 정확도 범위입니다. 실제 도로, 경로, 거리 안내는 아닙니다.</desc>
      <rect className="virtual-map__surface" x="18" y="22" width="284" height="176" rx="12" />
      <path className="virtual-map__grid" d="M18 66H302 M18 110H302 M18 154H302 M89 22V198 M160 22V198 M231 22V198" />
      {points.map((point) => point.kind === 'stop'
        ? <rect key={point.id} className="virtual-map__stop" x={point.x - 6} y={point.y - 6} width="12" height="12" rx="2">
          <title>{point.label}: {stop.name}</title>
        </rect>
        : <g key={point.id} className={`virtual-map__marker virtual-map__marker--${point.kind}`}>
          <circle className="virtual-map__accuracy" cx={point.x} cy={point.y} r={point.radius} />
          <circle className="virtual-map__dot" cx={point.x} cy={point.y} r="5" />
          <title>{point.label} · 오차 ±{Math.round(point.accuracyM)}m</title>
        </g>)}
    </svg>
    <ul className="virtual-map__legend" aria-label="위치도 표시 항목">
      <li><span className="virtual-map__swatch virtual-map__swatch--stop" aria-hidden="true" />{stop.name}</li>
      {markers.map((marker) => <li key={marker.id}>
        <span className={`virtual-map__swatch virtual-map__swatch--${marker.kind}`} aria-hidden="true" />{marker.label}
      </li>)}
    </ul>
    <figcaption>현재 좌표를 승차 지점 기준으로 표시합니다. 실제 도로·경로·거리 안내가 아닙니다.</figcaption>
  </figure>;
}
function NaverLocationMap({
  clientId,
  stop,
  own,
  shared,
}: {
  clientId: string;
  stop: { name: string; lat: number; lng: number };
  own: Omit<LocationPoint, 'nickname' | 'role' | 'key'> | null;
  shared: LocationPoint[];
}) {
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<NaverMap | null>(null);
  const overlays = useRef<NaverOverlay[]>([]);
  const center = useRef<{ lat: number; lng: number } | null>(null);
  const [status, setStatus] = useState('네이버 지도를 불러오는 중');
  const [maps, setMaps] = useState<NaverMaps | null>(null);
  const markers = [
    ...(own && isLocationFresh(own.receivedAt) ? [{
      id: 'self', label: '내 위치', kind: 'self' as const, lat: own.lat, lng: own.lng, accuracyM: own.accuracyM,
    }] : []),
    ...shared.filter((point) => isLocationFresh(point.receivedAt)).map((point) => ({
      id: point.key,
      label: point.role === 'DRIVER' ? '운전자 위치' : `${point.nickname} 위치`,
      kind: 'peer' as const, lat: point.lat, lng: point.lng, accuracyM: point.accuracyM,
    })),
  ];
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const markersKey = JSON.stringify(markers);

  useEffect(() => {
    let active = true;
    const authFailure = () => {
      overlays.current.forEach((overlay) => overlay.setMap(null));
      overlays.current = [];
      map.current = null;
      setMaps(null);
      setStatus('네이버 지도 인증에 실패했습니다. Client ID와 등록 도메인을 확인해 주세요.');
    };
    window.addEventListener('naver-map-auth-failure', authFailure);
    void loadNaverMaps(clientId).then((sdk) => {
      if (!active || !mapElement.current) return;
      map.current = new sdk.Map(mapElement.current, {
        center: new sdk.LatLng(stop.lat, stop.lng),
        zoom: 16,
      });
      center.current = { lat: stop.lat, lng: stop.lng };
      setMaps(sdk);
      setStatus('');
    }).catch(() => {
      if (active) setStatus('네이버 지도를 불러오지 못했습니다. 연결 상태와 Client ID를 확인해 주세요.');
    });
    return () => {
      active = false;
      window.removeEventListener('naver-map-auth-failure', authFailure);
      overlays.current.forEach((overlay) => overlay.setMap(null));
      overlays.current = [];
      map.current = null;
      center.current = null;
    };
  }, [clientId]);

  useEffect(() => {
    if (!maps || !map.current) return;
    if (center.current?.lat !== stop.lat || center.current.lng !== stop.lng) {
      map.current.setCenter(new maps.LatLng(stop.lat, stop.lng));
      center.current = { lat: stop.lat, lng: stop.lng };
    }
    overlays.current.forEach((overlay) => overlay.setMap(null));
    const nextOverlays: NaverOverlay[] = [];
    const stopPosition = new maps.LatLng(stop.lat, stop.lng);
    nextOverlays.push(new maps.Marker({
      map: map.current,
      position: stopPosition,
      title: `지정 승차 지점: ${stop.name}`,
      zIndex: 100,
    }));
    for (const marker of markersRef.current) {
      const position = new maps.LatLng(marker.lat, marker.lng);
      const color = marker.kind === 'self' ? '#2876b8' : '#2c8062';
      nextOverlays.push(new maps.Circle({
        map: map.current,
        center: position,
        radius: marker.accuracyM,
        fillColor: color,
        fillOpacity: 0.18,
        strokeColor: color,
        strokeOpacity: 0.5,
        strokeWeight: 1,
        clickable: false,
      }));
      nextOverlays.push(new maps.Marker({
        map: map.current,
        position,
        title: `${marker.label} · 오차 ±${Math.round(marker.accuracyM)}m`,
      }));
    }
    overlays.current = nextOverlays;
    return () => nextOverlays.forEach((overlay) => overlay.setMap(null));
  }, [maps, stop.lat, stop.lng, stop.name, markersKey]);

  if (status && status !== '네이버 지도를 불러오는 중') {
    return <>
      <p role="status">{status} 가상 위치도를 대신 표시합니다.</p>
      <VirtualLocationMap stop={stop} own={own} shared={shared} />
    </>;
  }

  return <figure className="naver-map">
    <div ref={mapElement} className="naver-map__canvas" role="region" aria-label="네이버 동승 위치 지도" tabIndex={0} />
    {status && <p className="naver-map__status" role="status">{status}</p>}
    <ul className="virtual-map__legend" aria-label="지도 표시 항목">
      <li><span className="virtual-map__swatch virtual-map__swatch--stop" aria-hidden="true" />{stop.name}</li>
      {markers.map((marker) => <li key={marker.id}>
        <span className={`virtual-map__swatch virtual-map__swatch--${marker.kind}`} aria-hidden="true" />{marker.label} · 오차 ±{Math.round(marker.accuracyM)}m
      </li>)}
    </ul>
    <figcaption>지도는 지정 승차 지점 중심입니다. 위치는 30초가 지나면 지도에서 숨깁니다.</figcaption>
  </figure>;
}
type Profile = {
  id: string; nickname: string; gender: string; role: 'STUDENT' | 'ADMIN';
  affiliation: { status: string; verifiedUntil: number | null };
  department: { status: string; id: string | null };
  driverProfile: { vehicleModel: string; vehicleColor: string; vehicleIdentifier: string; passengerCapacity: number; verificationStatus: string; verifiedUntil: number | null; checkedAt: number | null } | null;
  activeActivity: { role: 'DRIVER' | 'RIDER'; tripId: string | null; requestId: string | null } | null;
  activeTrip: { id: string; routeId: string; originName: string; destinationName: string; departureAt: number; expiresAt: number; seatCapacity: number; remainingSeats: number; genderFilter: string; preferSameDepartment: number; status: string; version: number } | null;
  activeRequest: { id: string; tripId: string; tripStatus: string; desiredDepartureAt: number; status: string; expiresAt: number; acceptedAt: number | null; boardedAt: number | null; version: number; driverId: string; driverNickname: string; originName: string; destinationName: string } | null;
  requiredConsents: Record<ConsentKind, ConsentState>;
  csrfToken: string;
};
type AdminReport = {
  id: string; reporterNickname: string; reportedUserId: string; reportedNickname: string;
  reportedRole: string; reportedAccountStatus: string; tripId: string; requestId: string;
  category: string; description: string; status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED'; createdAt: number;
};
type AdminVerificationRequest = { id: string; userId: string; nickname: string; departmentStatus: string; departmentId: string | null; createdAt: number };
type AdminDriverProfile = { userId: string; nickname: string; vehicleModel: string; vehicleColor: string; vehicleIdentifier: string; passengerCapacity: number; verificationStatus: string; verifiedUntil: number | null; checkedAt: number | null };
type AdminStop = { id: string; name: string; kind: 'GATE' | 'DESTINATION'; lat: number; lng: number; active: number };
type AdminRoute = { id: string; originStopId: string; destinationStopId: string; originName: string; destinationName: string; active: number };
type ReportableRequest = { requestId: string; tripId: string; otherUserId: string; otherNickname: string; requestStatus: string; tripStatus: string; endedAt: number };
type ActivePeer = { userId: string; nickname: string; role: 'DRIVER' | 'RIDER' };
type BlockedUser = { userId: string; nickname: string; createdAt: number };

function App() {
  const [status, setStatus] = useState('서버 연결 확인 중');
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRevision = useRef(0);
  const [routes, setRoutes] = useState<Array<{ id: string; originName: string; destinationName: string }>>([]);
  const [searchRouteId, setSearchRouteId] = useState('');
  const [tripRequests, setTripRequests] = useState<Array<{ id: string; riderId: string; desiredDepartureAt: number; status: string; expiresAt: number; acceptedAt: number | null; boardedAt: number | null; version: number; riderNickname: string; sameDepartment: boolean; matchReasons: Array<'SAME_DEPARTMENT' | 'DEPARTURE_TIME'>; conditionsCompatible: boolean }>>([]);
  const [adminReports, setAdminReports] = useState<AdminReport[]>([]);
  const [adminVerifications, setAdminVerifications] = useState<AdminVerificationRequest[]>([]);
  const [adminDriverProfiles, setAdminDriverProfiles] = useState<AdminDriverProfile[]>([]);
  const [adminReviewError, setAdminReviewError] = useState('');
  const [adminStops, setAdminStops] = useState<AdminStop[]>([]);
  const [adminRoutes, setAdminRoutes] = useState<AdminRoute[]>([]);
  const [adminCatalogError, setAdminCatalogError] = useState('');
  const [reportableRequests, setReportableRequests] = useState<ReportableRequest[]>([]);
  const [activePeers, setActivePeers] = useState<ActivePeer[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [tripMatches, setTripMatches] = useState<TripMatch[]>([]);
  const [searchFilters, setSearchFilters] = useState<TripSearchInput | null>(null);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [boardingCodes, setBoardingCodes] = useState<Record<string, { code: string; expiresAt: number }>>({});
  const [message, setMessage] = useState('');
  const [consentBusy, setConsentBusy] = useState(false);
  const [locationStarted, setLocationStarted] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [ownLocation, setOwnLocation] = useState<Omit<LocationPoint, 'nickname' | 'role' | 'key'> | null>(null);
  const [sharedLocations, setSharedLocations] = useState<LocationPoint[]>([]);
  const [locationDisclosures, setLocationDisclosures] = useState<LocationDisclosure[]>([]);
  const [locationStop, setLocationStop] = useState<{ name: string; lat: number; lng: number } | null>(null);
  const [tripBusy, setTripBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const tripIdempotency = useRef<{ body: string; key: string } | null>(null);
  const reportKeys = useRef(new Map<string, string>());
  const commandKeys = useRef(new Map<string, string>());
  const locationWatch = useRef<number | null>(null);
  const locationSequence = useRef(0);
  const lastLocationUpload = useRef(0);
  async function refreshMe(revision = profileRevision.current) {
    const response = await fetch('/api/v1/me', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = (await response.json() as { data: typeof profile }).data;
    if (revision !== profileRevision.current) return null;
    setProfile(data);
    return data;
  }
  async function refreshRequests(tripId = profile?.activeTrip?.id, revision = profileRevision.current) {
    if (!tripId) { setTripRequests([]); return; }
    const response = await fetch(`/api/v1/trips/${tripId}/requests`, { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json() as { data: typeof tripRequests }).data;
      if (revision === profileRevision.current) setTripRequests(data);
    }
  }
  async function refreshAdminReports(revision = profileRevision.current) {
    const response = await fetch('/api/v1/admin/reports', { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json() as { data: AdminReport[] }).data;
      if (revision === profileRevision.current) setAdminReports(data);
    }
  }
  async function refreshAdminReviews(revision = profileRevision.current, signal?: AbortSignal) {
    try {
      const [verificationResponse, driverResponse] = await Promise.all([
        fetch('/api/v1/admin/verification-requests', { cache: 'no-store', signal }),
        fetch('/api/v1/admin/driver-profiles', { cache: 'no-store', signal }),
      ]);
      if (!verificationResponse.ok || !driverResponse.ok) throw new Error('review queue unavailable');
      const [verificationData, driverData] = await Promise.all([
        verificationResponse.json() as Promise<{ data: AdminVerificationRequest[] }>,
        driverResponse.json() as Promise<{ data: AdminDriverProfile[] }>,
      ]);
      if (revision === profileRevision.current && !signal?.aborted) {
        setAdminVerifications(verificationData.data);
        setAdminDriverProfiles(driverData.data);
        setAdminReviewError('');
      }
    } catch {
      if (revision === profileRevision.current && !signal?.aborted) setAdminReviewError('확인 대기열을 불러오지 못했습니다. 새로고침해 주세요.');
    }
  }
  async function refreshAdminCatalog(revision = profileRevision.current, signal?: AbortSignal) {
    try {
      const [stopResponse, routeResponse] = await Promise.all([
        fetch('/api/v1/admin/stops', { cache: 'no-store', signal }),
        fetch('/api/v1/admin/routes', { cache: 'no-store', signal }),
      ]);
      if (!stopResponse.ok || !routeResponse.ok) throw new Error('catalog unavailable');
      const [stops, routeData] = await Promise.all([
        stopResponse.json() as Promise<{ data: AdminStop[] }>, routeResponse.json() as Promise<{ data: AdminRoute[] }>,
      ]);
      if (revision === profileRevision.current && !signal?.aborted) {
        setAdminStops(stops.data); setAdminRoutes(routeData.data); setAdminCatalogError('');
      }
    } catch {
      if (revision === profileRevision.current && !signal?.aborted) setAdminCatalogError('지점·노선 목록을 불러오지 못했습니다. 새로고침해 주세요.');
    }
  }
  async function saveAdminStop(id: string | null, form: FormData) {
    if (!profile || actionBusy) return;
    const input = adminStopSchema.safeParse({
      name: form.get('name'), kind: form.get('kind'), lat: Number(form.get('lat')), lng: Number(form.get('lng')),
      active: form.get('active') === 'on',
    });
    if (!input.success) { setMessage('지점 이름·종류·위도·경도를 확인해 주세요.'); return; }
    setActionBusy(true);
    try {
      const response = await fetch(id ? `/api/v1/admin/stops/${encodeURIComponent(id)}` : '/api/v1/admin/stops', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken }, body: JSON.stringify(input.data),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '지점을 저장하지 못했습니다.'); return; }
      setMessage(id ? '지점 정보를 저장했습니다.' : '지점을 추가했습니다.');
      await refreshAdminCatalog();
    } catch {
      setMessage('연결이 끊겼습니다. 지점 목록을 새로고침해 결과를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function saveAdminRoute(id: string | null, form: FormData) {
    if (!profile || actionBusy) return;
    const path = id ? `/api/v1/admin/routes/${encodeURIComponent(id)}` : '/api/v1/admin/routes';
    const method = id ? 'PATCH' : 'POST';
    const schema = id ? adminRouteUpdateSchema : adminRouteCreateSchema;
    const body = id
      ? { active: form.get('active') === 'on' }
      : { originStopId: String(form.get('originStopId') ?? ''), destinationStopId: String(form.get('destinationStopId') ?? '') };
    const input = schema.safeParse(body);
    if (!input.success) { setMessage('활성 교문과 목적지를 확인해 주세요.'); return; }
    setActionBusy(true);
    try {
      const response = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken }, body: JSON.stringify(input.data),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '노선을 저장하지 못했습니다.'); return; }
      setMessage(id ? '노선 사용 상태를 저장했습니다.' : '노선을 추가했습니다.');
      await refreshAdminCatalog();
    } catch {
      setMessage('연결이 끊겼습니다. 노선 목록을 새로고침해 결과를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function refreshReportableRequests(revision = profileRevision.current) {
    const response = await fetch('/api/v1/me/reportable-requests', { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json() as { data: ReportableRequest[] }).data;
      if (revision === profileRevision.current) setReportableRequests(data);
    }
  }
  async function refreshBlocks(revision = profileRevision.current) {
    const response = await fetch('/api/v1/blocks', { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json() as { data: BlockedUser[] }).data;
      if (revision === profileRevision.current) setBlockedUsers(data);
    }
  }
  async function refreshActivePeers(revision = profileRevision.current) {
    const response = await fetch('/api/v1/me/active-peers', { cache: 'no-store' });
    if (response.ok) {
      const data = (await response.json() as { data: ActivePeer[] }).data;
      if (revision === profileRevision.current) setActivePeers(data);
    }
  }
  async function submitReport(requestId: string, form: FormData) {
    if (!profile || actionBusy) return;
    const input = reportCreateSchema.safeParse({ requestId, category: form.get('category'), description: form.get('description') });
    if (!input.success) { setMessage('신고 유형과 내용을 확인해 주세요.'); return; }
    const key = reportKeys.current.get(requestId) ?? crypto.randomUUID();
    reportKeys.current.set(requestId, key);
    setActionBusy(true);
    try {
      const response = await fetch('/api/v1/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': key },
        body: JSON.stringify(input.data),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (response.ok) {
        reportKeys.current.delete(requestId);
        setMessage('신고를 접수했습니다. 신고 내용은 운영자만 확인할 수 있습니다.');
        await refreshReportableRequests();
      } else {
        if (response.status < 500 && response.status !== 429) reportKeys.current.delete(requestId);
        setMessage(payload?.error?.message ?? '신고를 접수하지 못했습니다. 관계와 입력을 확인해 주세요.');
      }
    } catch {
      setMessage('연결이 끊겨 신고 접수 여부를 확인하지 못했습니다. 접수 여부를 운영자에게 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function updateReport(reportId: string, status: 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED') {
    if (!profile || actionBusy) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/reports/${reportId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '신고 상태를 변경하지 못했습니다.'); return; }
      setMessage('신고 상태를 기록했습니다.');
      await refreshAdminReports();
    } catch {
      setMessage('연결이 끊겼습니다. 신고 목록을 새로 고쳐 상태를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function reviewAdminProfile(kind: 'student' | 'driver', id: string, outcome: 'VERIFIED' | 'REJECTED', form?: FormData) {
    if (!profile || actionBusy) return;
    const validUntil = outcome === 'VERIFIED' ? Date.parse(`${String(form?.get('validUntil') ?? '')}+09:00`) : undefined;
    const body = outcome === 'VERIFIED' ? { outcome, validUntil } : { outcome };
    const schema = kind === 'student' ? verificationDecisionSchema : driverProfileDecisionSchema;
    const input = schema.safeParse(body);
    if (!input.success || (input.data.outcome === 'VERIFIED' && input.data.validUntil <= Date.now())) {
      setMessage('승인하려면 현재보다 뒤인 유효기간을 한국 시간으로 입력해 주세요.');
      return;
    }
    setActionBusy(true);
    try {
      const path = kind === 'student'
        ? `/api/v1/admin/verification-requests/${encodeURIComponent(id)}`
        : `/api/v1/admin/driver-profiles/${encodeURIComponent(id)}`;
      const response = await fetch(path, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify(input.data),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '검토 결과를 저장하지 못했습니다. 대기 상태를 새로고침해 주세요.'); return; }
      setMessage(outcome === 'VERIFIED' ? '확인 결과와 유효기간을 기록했습니다.' : '확인 요청을 거절했습니다.');
      await refreshAdminReviews();
    } catch {
      setMessage('연결이 끊겼습니다. 대기열을 새로고침해 결과를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function suspendUser(userId: string, nickname: string) {
    if (!profile || actionBusy || !window.confirm(`${nickname}님의 계정을 정지할까요? 세션을 회수하고 진행 중인 요청·운행을 종료합니다. 탑승 관계가 있거나 출발한 운행은 중단되며 위치가 삭제됩니다.`)) return;
    const reason = window.prompt('정지 사유를 입력해 주세요. (최대 500자)');
    if (reason === null) return;
    const input = suspendUserSchema.safeParse({ reason });
    if (!input.success) { setMessage('정지 사유는 1~500자로 입력해 주세요.'); return; }
    setActionBusy(true);
    try {
      const response = await fetch(`/api/v1/admin/users/${userId}/suspend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify(input.data),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '계정을 정지하지 못했습니다.'); return; }
      setMessage('계정을 정지하고 세션과 진행 활동을 회수했습니다.');
      await refreshAdminReports();
    } catch {
      setMessage('연결이 끊겼습니다. 신고 목록을 새로 고쳐 계정 상태를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function blockUser(userId: string, nickname: string) {
    if (!profile || actionBusy || !window.confirm(`${nickname}님을 차단할까요? 현재 동승 관계가 종료될 수 있으며, 이미 탑승한 사람이 있으면 운행이 중단됩니다.`)) return;
    setActionBusy(true);
    try {
      const response = await fetch('/api/v1/blocks', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ blockedUserId: userId }),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '사용자를 차단하지 못했습니다.'); return; }
      const updated = await refreshMe();
      if (!updated?.activeActivity) {
        stopLocationWatch();
        setOwnLocation(null);
        setSharedLocations([]);
      }
      await Promise.all([refreshBlocks(), refreshReportableRequests(), refreshActivePeers()]);
      setMessage('사용자를 차단했습니다. 종료된 동승 관계는 차단 해제 후에도 복구되지 않습니다.');
    } catch {
      setMessage('연결이 끊겼습니다. 차단 목록을 새로고침해 처리 여부를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function unblockUser(userId: string) {
    if (!profile || actionBusy) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/v1/blocks/${userId}`, {
        method: 'DELETE', headers: { 'X-CSRF-Token': profile.csrfToken },
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setMessage(payload?.error?.message ?? '차단을 해제하지 못했습니다.'); return; }
      await refreshBlocks();
      setMessage('차단을 해제했습니다. 이전 동승 관계는 다시 열리지 않습니다.');
    } catch {
      setMessage('연결이 끊겼습니다. 차단 목록을 새로고침해 처리 여부를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function mutate(path: string, body: unknown, successMessage: string) {
    if (!profile || actionBusy) return null;
    const bodyText = JSON.stringify(body);
    const fingerprint = `${path}:${bodyText}`;
    const key = commandKeys.current.get(fingerprint) ?? crypto.randomUUID();
    commandKeys.current.set(fingerprint, key);
    setActionBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': key },
        body: bodyText,
      });
      const payload = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null;
      if (!response.ok) {
        setMessage(payload?.error?.message ?? '상태를 변경하지 못했습니다. 최신 상태를 확인해 주세요.');
        return null;
      }
      commandKeys.current.delete(fingerprint);
      setMessage(successMessage);
      const updated = await refreshMe();
      await refreshRequests(updated?.activeTrip?.id);
      return payload?.data ?? null;
    } catch {
      setMessage('연결이 끊겼습니다. 같은 동작을 다시 누르면 같은 요청 키로 결과를 확인합니다.');
      return null;
    } finally {
      setActionBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/health', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        healthResponse.parse(await response.json());
        setStatus('로컬 Worker · D1 연결 정상');
        await refreshMe();
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('서버에 연결할 수 없습니다. 로컬 migration을 확인해 주세요.'); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (profile?.role !== 'ADMIN') {
      setAdminReports([]); setAdminVerifications([]); setAdminDriverProfiles([]); setAdminReviewError('');
      setAdminStops([]); setAdminRoutes([]); setAdminCatalogError(''); return;
    }
    const revision = profileRevision.current;
    const controller = new AbortController();
    void fetch('/api/v1/admin/reports', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json() as { data: AdminReport[] }).data;
        if (revision === profileRevision.current) setAdminReports(data);
      }).catch(() => {});
    void refreshAdminReviews(revision, controller.signal);
    void refreshAdminCatalog(revision, controller.signal);
    return () => controller.abort();
  }, [profile?.id, profile?.role]);
  useEffect(() => {
    if (!profile || profile.role !== 'STUDENT') {
      setReportableRequests([]); setBlockedUsers([]); setActivePeers([]); return;
    }
    const revision = profileRevision.current;
    const controller = new AbortController();
    void fetch('/api/v1/me/reportable-requests', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json() as { data: ReportableRequest[] }).data;
        if (revision === profileRevision.current) setReportableRequests(data);
      }).catch(() => {});
    void refreshBlocks(revision);
    void refreshActivePeers(revision);
    return () => controller.abort();
  }, [profile?.id, profile?.role, profile?.requiredConsents.TERMS.accepted, profile?.activeActivity?.role,
    profile?.activeActivity?.requestId, profile?.activeTrip?.id, profile?.activeTrip?.status, profile?.activeRequest?.status]);
  async function login(identity: 'driver' | 'rider' | 'pending' | 'admin') {
    const revision = ++profileRevision.current;
    const input = devLoginSchema.parse({ identity });
    const response = await fetch('/api/v1/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (revision !== profileRevision.current) return;
    if (!response.ok) return setMessage('로컬 seed를 적용하고 로컬 Worker에서 실행해 주세요.');
    await refreshMe(revision);
    if (revision === profileRevision.current) setMessage('합성 계정으로 로그인했습니다. 실제 학교 계정은 사용하지 않습니다.');
  }
  async function updateProfile(form: FormData) {
    if (!profile) return;
    if (!profile.requiredConsents.TERMS.accepted || !profile.requiredConsents.PRIVACY.accepted) {
      setMessage('필수 안내에 먼저 동의해 주세요.');
      return;
    }
    const input = profileUpdateSchema.parse({ nickname: form.get('nickname'), gender: form.get('gender') });
    const response = await fetch('/api/v1/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
      body: JSON.stringify(input),
    });
    setMessage(response.ok ? '프로필을 저장했습니다.' : '활동 중인지 확인하고 다시 시도해 주세요.');
    if (response.ok) {
      await refreshMe();
    }
  }
  async function requestVerification() {
    if (!profile) return;
    const response = await fetch('/api/v1/me/verification-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
    });
    setMessage(response.ok ? '학생 확인 요청을 접수했습니다.' : '학생 확인 요청을 접수하지 못했습니다.');
  }
  async function updateDriverProfile(form: FormData) {
    if (!profile) return;
    const input = driverProfileSchema.parse({
      vehicleModel: form.get('vehicleModel'), vehicleColor: form.get('vehicleColor'),
      vehicleIdentifier: form.get('vehicleIdentifier'), passengerCapacity: Number(form.get('passengerCapacity')),
    });
    const response = await fetch('/api/v1/me/driver-profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      setMessage(response.status === 403 ? '유효한 학생 확인과 필수 동의가 필요합니다.' : '활동 중인지 확인하고 차량 정보를 다시 저장해 주세요.');
      return;
    }
    await refreshMe();
    setMessage('차량 정보를 저장했습니다. 승인 전에는 운행을 만들 수 없습니다.');
  }
  async function createTrip(form: FormData) {
    if (!profile || tripBusy) return;
    const revision = profileRevision.current;
    const input = tripCreateSchema.parse({
      routeId: form.get('routeId'), departureAt: Date.parse(`${String(form.get('departureAt'))}+09:00`),
      seatCapacity: Number(form.get('seatCapacity')), genderFilter: form.get('genderFilter'),
      preferSameDepartment: form.get('preferSameDepartment') === 'on',
    });
    const body = JSON.stringify(input);
    if (!tripIdempotency.current || tripIdempotency.current.body !== body) {
      tripIdempotency.current = { body, key: crypto.randomUUID() };
    }
    setTripBusy(true);
    try {
      const response = await fetch('/api/v1/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': tripIdempotency.current.key },
        body,
      });
      if (!response.ok) {
        setMessage(response.status === 409 ? '이미 진행 중인 활동이 있거나 운행 조건이 변경되었습니다.' : '학생·차량 승인과 운행 조건을 확인해 주세요.');
        return;
      }
      const me = await fetch('/api/v1/me', { cache: 'no-store' });
      if (!me.ok) {
        setMessage('운행은 등록됐습니다. 최신 상태를 확인하려면 화면을 새로고침해 주세요.');
        return;
      }
      const updatedProfile = (await me.json() as { data: typeof profile }).data;
      if (revision !== profileRevision.current) return;
      setProfile(updatedProfile);
      tripIdempotency.current = null;
      setMessage('운행을 등록했습니다. 운행 ID를 탑승자와 공유해 주세요.');
    } catch {
      setMessage('연결이 끊겼습니다. 같은 내용을 다시 보내면 기존 등록 결과를 확인합니다.');
    } finally {
      setTripBusy(false);
    }
  }
  async function loadTrips(filters: TripSearchInput, cursor: string | null = null) {
    if (searchBusy) return;
    const params = new URLSearchParams({
      routeId: filters.routeId, desiredDepartureAt: String(filters.desiredDepartureAt),
      genderFilter: filters.genderFilter, preferSameDepartment: String(filters.preferSameDepartment),
      ...(cursor ? { cursor } : {}),
    });
    setSearchBusy(true);
    try {
      const response = await fetch(`/api/v1/trips?${params}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(response.status === 409 ? '검색 이후 조건이 바뀌었습니다. 다시 검색해 주세요.' : '운행을 찾지 못했습니다. 조건을 확인해 주세요.');
        return;
      }
      const parsed = tripSearchResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setMessage('운행 검색 결과를 읽지 못했습니다. 다시 검색해 주세요.');
        return;
      }
      setTripMatches((previous) => cursor ? [...previous, ...parsed.data.data] : parsed.data.data);
      setSearchFilters(filters);
      setSearchCursor(parsed.data.nextCursor);
      setMessage(parsed.data.data.length || cursor ? '' : '현재 조건에 맞는 운행이 없습니다. 조건을 바꾸거나 나중에 다시 검색해 주세요.');
    } catch {
      setMessage('연결이 끊겼습니다. 검색을 다시 시도해 주세요.');
    } finally {
      setSearchBusy(false);
    }
  }
  async function searchTrips(form: FormData) {
    const parsed = tripSearchSchema.safeParse({
      routeId: form.get('routeId'),
      desiredDepartureAt: Date.parse(`${String(form.get('desiredDepartureAt'))}+09:00`),
      genderFilter: form.get('genderFilter'), preferSameDepartment: form.get('preferSameDepartment') === 'on',
    });
    if (!parsed.success) {
      setMessage('노선·희망 시각·매칭 조건을 확인해 주세요.');
      return;
    }
    setTripMatches([]);
    setSearchCursor(null);
    await loadTrips(parsed.data);
  }
  async function requestMatch(trip: TripMatch) {
    if (!searchFilters) return;
    const body = rideRequestCreateSchema.parse({
      desiredDepartureAt: searchFilters.desiredDepartureAt,
      genderFilter: searchFilters.genderFilter,
      preferSameDepartment: searchFilters.preferSameDepartment,
    });
    await mutate(`/api/v1/trips/${trip.id}/requests`, body, '탑승 요청을 보냈습니다.');
  }
  async function issueBoardingCode(requestId: string) {
    if (!profile || actionBusy) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/v1/requests/${requestId}/boarding-code`, {
        method: 'POST', headers: { 'X-CSRF-Token': profile.csrfToken },
      });
      const payload = await response.json().catch(() => null) as { data?: { code: string; expiresAt: number }; error?: { message?: string } } | null;
      if (!response.ok || !payload?.data) {
        setMessage(payload?.error?.message ?? '탑승 코드를 발급하지 못했습니다.');
        return;
      }
      setBoardingCodes({ [requestId]: payload.data });
      setMessage('탑승 코드는 차량에서 운전자에게 직접 보여 주세요.');
    } catch {
      setMessage('탑승 코드를 발급하지 못했습니다. 요청 상태를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function boardRequest(requestId: string, version: number, code: string) {
    if (!profile || actionBusy) return;
    setActionBusy(true);
    try {
      const response = await fetch(`/api/v1/requests/${requestId}/board`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ expectedVersion: version, code }),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setMessage(payload?.error?.message ?? '탑승 코드를 확인하지 못했습니다.');
        return;
      }
      setMessage('탑승을 확인했습니다. 출발 전에 미탑승 요청을 정리해 주세요.');
      await refreshMe();
      await refreshRequests();
    } catch {
      setMessage('연결이 끊겼습니다. 새로고침해 서버 상태를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  async function updateConsent(kind: ConsentKind, granted: boolean) {
    if (!profile || consentBusy) return;
    const revision = profileRevision.current;
    setConsentBusy(true);
    try {
      const policy = profile.requiredConsents[kind];
      setProfile({ ...profile, requiredConsents: { ...profile.requiredConsents, [kind]: { ...policy, accepted: granted } } });
      const response = await fetch('/api/v1/me/consents', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ kind, policyVersion: policy.version, granted }),
      });
      if (!response.ok) throw new Error('consent update failed');
      const me = await fetch('/api/v1/me', { cache: 'no-store' });
      if (!me.ok) throw new Error('profile refresh failed');
      const updatedProfile = (await me.json() as { data: typeof profile }).data;
      if (revision !== profileRevision.current) return;
      setProfile(updatedProfile);
      setMessage(granted ? '동의 상태를 저장했습니다.' : '동의를 철회했습니다.');
      if (!granted && kind.startsWith('LOCATION_')) {
        setLocationDisclosures([]);
        if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current);
        locationWatch.current = null;
        setLocationStarted(false);
        setOwnLocation(null);
        setSharedLocations([]);
        setLocationStatus('위치 동의를 철회했습니다. 공유 위치를 삭제했습니다.');
      }
    } catch {
      if (revision === profileRevision.current) {
        setProfile(profile);
        setMessage('동의 상태를 저장하지 못했습니다. 최신 안내를 새로고침해 주세요.');
      }
    } finally {
      if (revision === profileRevision.current) setConsentBusy(false);
    }
  }
  function stopLocationWatch() {
    if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current);
    locationWatch.current = null;
    setLocationStarted(false);
  }
  async function startLocationSharing(context: { tripId: string; requestId: string | null }) {
    if (!profile || locationWatch.current !== null) return;
    const revision = profileRevision.current;
    if (!profile.requiredConsents.LOCATION_COLLECTION.accepted || !profile.requiredConsents.LOCATION_SHARING.accepted) {
      setLocationStatus('위치 수집과 상대 제공에 각각 동의한 뒤 시작해 주세요.');
      return;
    }
    if (!navigator.geolocation) {
      setLocationStatus('이 브라우저는 위치 기능을 지원하지 않습니다. 지정 승차 지점에서 만나 탑승 코드를 사용해 주세요.');
      return;
    }
    if (document.hidden) {
      setLocationStatus('화면을 열어 둔 상태에서 위치 공유를 시작해 주세요.');
      return;
    }
    try {
      const current = await fetch('/api/v1/locations/me', { cache: 'no-store' });
      const latest = await current.json().catch(() => null) as { data?: { sequence: number } } | null;
      if (!current.ok || !latest?.data) throw new Error('location context unavailable');
      if (revision !== profileRevision.current) return;
      locationSequence.current = latest.data.sequence;
      lastLocationUpload.current = 0;
      setLocationStatus('브라우저 위치 권한을 확인하고 있습니다.');
      const watchId = navigator.geolocation.watchPosition(async (position) => {
        if (locationWatch.current === null || document.hidden || Date.now() - lastLocationUpload.current < 10_000) return;
        const capturedAt = Math.round(position.timestamp);
        const sequence = ++locationSequence.current;
        const receivedAt = Date.now();
        lastLocationUpload.current = receivedAt;
        const point = {
          lat: position.coords.latitude, lng: position.coords.longitude, accuracyM: position.coords.accuracy,
          capturedAt, receivedAt, expiresAt: receivedAt + 60_000, sequence,
        };
        setOwnLocation(point);
        try {
          const response = await fetch('/api/v1/locations/me', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
            body: JSON.stringify({ tripId: context.tripId, requestId: context.requestId,
              lat: point.lat, lng: point.lng, accuracyM: point.accuracyM, capturedAt, sequence }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
            setLocationStatus(payload?.error?.message ?? '위치를 공유하지 못했습니다. 지정 지점과 탑승 코드를 사용해 주세요.');
            if (response.status === 403 || response.status === 409) stopLocationWatch();
            return;
          }
          setLocationStatus(position.coords.accuracy > 100
            ? '위치 오차가 커 정확한 만남에는 적합하지 않습니다. 지정 승차 지점에서 만나 주세요.'
            : position.coords.accuracy > 50
              ? '위치 오차가 있습니다. 지정 승차 지점에서 만나 주세요.'
              : '위치를 갱신했습니다. 동승 상대에게 실제 제공되면 제공 내역을 여기에 표시합니다.');
        } catch {
          setLocationStatus('연결이 끊겨 위치를 전송하지 못했습니다. 지정 승차 지점에서 만나 주세요.');
        }
      }, (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? '위치 권한이 거절되었습니다. 지정 승차 지점에서 만나 탑승 코드를 사용해 주세요.'
          : error.code === error.TIMEOUT
            ? '위치를 제때 가져오지 못했습니다. 다시 시도하거나 지정 승차 지점을 이용해 주세요.'
            : '현재 위치를 가져오지 못했습니다. 지정 승차 지점에서 만나 주세요.';
        stopLocationWatch();
        setLocationStatus(message);
      }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 });
      locationWatch.current = watchId;
      setLocationStarted(true);
    } catch {
      setLocationStatus('위치 공유 관계를 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    }
  }
  async function acknowledgeLocationDisclosure(disclosure: LocationDisclosure) {
    if (!profile || actionBusy) return;
    const revision = profileRevision.current;
    setActionBusy(true);
    try {
      const response = await fetch('/api/v1/locations/me/disclosures/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ disclosureIds: [disclosure.id] }),
      });
      const payload = await response.json().catch(() => null) as {
        data?: { acknowledgedAt: number; disclosureIds: string[] }; error?: { message?: string };
      } | null;
      if (revision !== profileRevision.current) return;
      if (!response.ok || !payload?.data?.disclosureIds.includes(disclosure.id)) {
        setMessage(payload?.error?.message ?? '위치 안내 확인을 저장하지 못했습니다. 내역을 새로고침해 주세요.');
        return;
      }
      const acknowledgedAt = payload.data.acknowledgedAt;
      setLocationDisclosures((current) => current.map((item) => item.id !== disclosure.id ? item : item.providedAt === null
        ? { ...item, noticeAcknowledgedAt: acknowledgedAt }
        : { ...item, postNoticeAcknowledgedAt: acknowledgedAt }));
      setMessage('위치 안내 확인을 기록했습니다.');
    } catch {
      if (revision === profileRevision.current) setMessage('연결이 끊겨 위치 안내 확인을 저장하지 못했습니다. 내역을 새로고침해 주세요.');
    } finally {
      if (revision === profileRevision.current) setActionBusy(false);
    }
  }
  async function logout() {
    if (!profile) return;
    const revision = profileRevision.current;
    await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': profile.csrfToken } });
    if (revision !== profileRevision.current) return;
    profileRevision.current += 1;
    stopLocationWatch();
    stopLocationWatch();
    setProfile(null);
    setTripRequests([]);
    setConsentBusy(false);
    setTripBusy(false);
    setOwnLocation(null);
    setSharedLocations([]);
    setLocationDisclosures([]);
    setLocationStop(null);
    setMessage('로그아웃했습니다.');
  }
  async function deleteAccount() {
    if (!profile || actionBusy || !window.confirm('계정을 탈퇴할까요? 직접 식별정보와 현재 위치를 정리하고 진행 중 운행·요청을 종료합니다. 일부 운행·신고·동의·위치 확인 기록은 정해진 기간 보관됩니다. D1의 7일 복구 창 안에 삭제 전 정보가 되살아날 수 있어 복구 시 탈퇴 기록을 다시 적용합니다.')) return;
    const revision = profileRevision.current;
    setActionBusy(true);
    try {
      const response = await fetch('/api/v1/me', { method: 'DELETE', headers: { 'X-CSRF-Token': profile.csrfToken } });
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (!response.ok) {
        setMessage(payload?.error?.code === 'REAUTH_REQUIRED'
          ? '탈퇴하려면 로그아웃한 뒤 다시 로그인하고 5분 안에 요청해 주세요.'
          : payload?.error?.message ?? '계정을 탈퇴하지 못했습니다.');
        return;
      }
      if (revision !== profileRevision.current) return;
      profileRevision.current += 1;
      stopLocationWatch();
      setProfile(null); setTripRequests([]); setOwnLocation(null); setSharedLocations([]); setLocationDisclosures([]); setLocationStop(null);
      setBoardingCodes({});
      setMessage('계정 탈퇴를 처리했습니다. 연결된 일부 기록은 정해진 기간 보관되며 D1 복구 창에서는 삭제 전 상태가 복원될 수 있습니다.');
    } catch {
      setMessage('연결이 끊겼습니다. 로그인 여부를 확인해 탈퇴 결과를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  const canUseProfile = Boolean(!consentBusy && profile?.requiredConsents.TERMS.accepted && profile.requiredConsents.PRIVACY.accepted);
  const canRegisterDriver = Boolean(canUseProfile && profile?.affiliation.status === 'VERIFIED'
    && (profile.affiliation.verifiedUntil ?? 0) > Date.now());
  const hasBlockingActivity = Boolean(profile?.activeActivity
    && !(profile.activeActivity.role === 'DRIVER' && profile.activeTrip?.status === 'EXPIRED'));
  const canCreateTrip = Boolean(canRegisterDriver && profile?.driverProfile?.verificationStatus === 'VERIFIED'
    && (profile.driverProfile.verifiedUntil ?? 0) > Date.now() && !hasBlockingActivity);
  const canRequestRide = Boolean(canRegisterDriver && !hasBlockingActivity);
  const locationConsented = Boolean(profile?.requiredConsents.LOCATION_COLLECTION.accepted
    && profile.requiredConsents.LOCATION_SHARING.accepted);
  const activeLocationContext = profile?.activeActivity?.role === 'DRIVER'
    && profile.activeTrip?.status === 'OPEN'
    && tripRequests.some((item) => item.status === 'ACCEPTED' || item.status === 'BOARDED')
    ? { tripId: profile.activeTrip.id, requestId: null as string | null }
    : profile?.activeActivity?.role === 'RIDER' && profile.activeRequest
      && profile.activeRequest.tripStatus === 'OPEN'
      && (profile.activeRequest.status === 'ACCEPTED' || profile.activeRequest.status === 'BOARDED')
      ? { tripId: profile.activeRequest.tripId, requestId: profile.activeRequest.id }
      : null;
  const tripDepartureMin = seoulDateTimeInput(Math.ceil(Date.now() / 60_000) * 60_000);
  const tripDepartureMax = seoulDateTimeInput(Date.now() + 30 * 60_000);
  useEffect(() => {
    if (!canRequestRide || hasBlockingActivity) {
      setRoutes([]);
      return;
    }
    const controller = new AbortController();
    void fetch('/api/v1/routes', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('routes unavailable');
        setRoutes((await response.json() as { data: typeof routes }).data);
      })
      .catch(() => { if (!controller.signal.aborted) setRoutes([]); });
    return () => controller.abort();
  }, [canRequestRide, hasBlockingActivity]);
  useEffect(() => {
    if (routes.length && !routes.some((route) => route.id === searchRouteId)) setSearchRouteId(routes[0].id);
  }, [routes, searchRouteId]);
  useEffect(() => {
    if (!profile?.activeTrip || profile.activeActivity?.role !== 'DRIVER') {
      setTripRequests([]);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/v1/trips/${profile.activeTrip.id}/requests`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('requests unavailable');
        setTripRequests((await response.json() as { data: typeof tripRequests }).data);
      })
      .catch(() => { if (!controller.signal.aborted) setTripRequests([]); });
    return () => controller.abort();
  }, [profile?.activeTrip?.id, profile?.activeActivity?.role]);
  useEffect(() => {
    if (!profile?.activeActivity || actionBusy) return;
    let loading = false;
    let stopped = false;
    const revision = profileRevision.current;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || revision !== profileRevision.current || loading || document.visibilityState !== 'visible') return;
      loading = true;
      try {
        const response = await fetch('/api/v1/me', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok || stopped || revision !== profileRevision.current) return;
        const data = (await response.json() as { data: typeof profile }).data;
        if (stopped || revision !== profileRevision.current) return;
        setProfile(data);
        if (data?.activeTrip && data.activeActivity?.role === 'DRIVER') {
          const requests = await fetch(`/api/v1/trips/${data.activeTrip.id}/requests`, { signal: controller.signal, cache: 'no-store' });
          if (requests.ok && !stopped && revision === profileRevision.current) {
            const requestData = (await requests.json() as { data: typeof tripRequests }).data;
            if (!stopped && revision === profileRevision.current) setTripRequests(requestData);
          }
        } else {
          if (!stopped && revision === profileRevision.current) setTripRequests([]);
        }
      } catch {
        // Keep the last server state visible during a temporary connection failure.
      } finally {
        loading = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [profile?.activeActivity?.role, profile?.activeActivity?.requestId, profile?.activeTrip?.id, actionBusy]);
  useEffect(() => {
    const stopWhenHidden = () => {
      if (!document.hidden) return;
      if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current);
      locationWatch.current = null;
      setLocationStarted(false);
      setLocationStatus('화면이 숨겨져 위치 수집을 멈췄습니다. 돌아온 뒤 다시 시작해 주세요.');
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', stopWhenHidden);
      if (locationWatch.current !== null) navigator.geolocation?.clearWatch(locationWatch.current);
      locationWatch.current = null;
    };
  }, []);
  useEffect(() => {
    if (activeLocationContext && locationConsented) return;
    stopLocationWatch();
    setOwnLocation(null);
    setSharedLocations([]);
    setLocationStop(null);
  }, [activeLocationContext?.tripId, activeLocationContext?.requestId, locationConsented, profile?.csrfToken]);
  useEffect(() => {
    setLocationDisclosures([]);
    if (!profile?.id || !profile.requiredConsents.TERMS.accepted || !profile.requiredConsents.PRIVACY.accepted) return;
    const revision = profileRevision.current;
    const controller = new AbortController();
    void fetch('/api/v1/locations/me', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json() as { data: { disclosures: LocationDisclosure[] } }).data;
        if (!controller.signal.aborted && revision === profileRevision.current) setLocationDisclosures(data.disclosures);
      }).catch(() => {});
    return () => controller.abort();
  }, [profile?.id, profile?.requiredConsents.TERMS.accepted, profile?.requiredConsents.PRIVACY.accepted]);
  useEffect(() => {
    if (!activeLocationContext || !locationConsented) return;
    let stopped = false;
    let running = false;
    const revision = profileRevision.current;
    let delay = 5_000;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      controller = new AbortController();
      try {
        const [ownResponse, peerResponse] = await Promise.all([
          fetch('/api/v1/locations/me', { signal: controller.signal, cache: 'no-store' }),
          fetch(`/api/v1/trips/${activeLocationContext.tripId}/locations`, { signal: controller.signal, cache: 'no-store' }),
        ]);
        if (!ownResponse.ok || !peerResponse.ok) throw new Error('location unavailable');
        const own = await ownResponse.json() as { data: { sequence: number; location: typeof ownLocation; disclosures: LocationDisclosure[] } };
        const peers = await peerResponse.json() as { data: { stop: typeof locationStop; locations: LocationPoint[] } };
        if (stopped || controller.signal.aborted || revision !== profileRevision.current) return;
        locationSequence.current = Math.max(locationSequence.current, own.data.sequence);
        setOwnLocation(own.data.location);
        setLocationDisclosures(own.data.disclosures);
        setLocationStop(peers.data.stop);
        setSharedLocations((current) => {
          const incomingKeys = new Set(peers.data.locations.map(({ key }) => key));
          const retained = current.filter((point) => point.expiresAt > Date.now() && !incomingKeys.has(point.key));
          return [...retained, ...peers.data.locations];
        });
        delay = 5_000;
      } catch {
        if (!controller.signal.aborted) {
          delay = Math.min(delay * 2, 30_000);
          setLocationStatus('위치 상태를 새로 확인하지 못했습니다. 최신 위치를 현재 위치로 간주하지 마세요.');
        }
      } finally {
        running = false;
        controller = null;
        if (!stopped && !document.hidden) timer = window.setTimeout(() => void poll(), delay);
      }
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        if (timer !== null) window.clearTimeout(timer);
        controller?.abort();
      } else {
        delay = 5_000;
        void poll();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void poll();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [activeLocationContext?.tripId, activeLocationContext?.requestId, locationConsented]);
  return <main>
    <p className="eyebrow">CAMPUS RIDE / LOCAL DEVELOPMENT</p>
    <h1>함께 올라가는<br />캠퍼스의 시작.</h1>
    <p>교문에서 캠퍼스까지, 학생들을 연결하는 동승 서비스입니다.</p>
    <section aria-labelledby="development-title">
      <h2 id="development-title">개발 환경 준비 중</h2>
      <p role="status">{status}</p>
      {profile ? <>
        <h3>{profile.nickname}</h3>
        <p>학생 확인: {profile.affiliation.status} · 학과: {profile.department.status}</p>
        <section aria-labelledby="consent-title">
          <h3 id="consent-title">약관·개인정보 확인과 위치 설정</h3>
          <p>서비스 이용약관 확인과 개인정보 처리방침 확인이 필요합니다. 처리방침 확인은 별도의 개인정보 처리 동의를 대신하지 않습니다. 위치 수집과 동승 상대 제공은 각각 선택하며, 여기서 철회할 수 있습니다.</p>
          {(['TERMS', 'PRIVACY', 'LOCATION_COLLECTION', 'LOCATION_SHARING'] as const).map((kind) => {
            const policy = profile.requiredConsents[kind];
            const title = kind === 'TERMS' ? '서비스 이용 약관'
              : kind === 'PRIVACY' ? '개인정보 처리방침 확인'
                : kind === 'LOCATION_COLLECTION' ? '내 위치를 임시 수집' : '내 위치를 동승 상대에게 제공';
            return <div className="consent-row" key={kind}>
              <label><input type="checkbox" checked={policy.accepted} disabled={consentBusy}
                onChange={(event) => void updateConsent(kind, event.currentTarget.checked)} /> {title} ({policy.version})</label>
              {policy.url ? <a href={policy.url} target="_blank" rel="noreferrer">내용 보기</a>
                : <p>{kind.startsWith('LOCATION_')
                  ? '로컬 개발용 안내입니다. 실제 개인위치정보 처리 고지나 법적 동의 문구가 아닙니다.'
                  : '로컬 개발용 동의 체험입니다. 실제 약관이나 개인정보 처리 안내가 아니며 합성 계정만 사용합니다.'}</p>}
            </div>;
          })}
          <h4>내 위치 제공 내역</h4>
          {locationDisclosures.length ? <ul aria-label="내 위치 제공 내역">
            {locationDisclosures.map((disclosure) => {
              const recipientRole = disclosure.recipientRole === 'DRIVER' ? '운전자' : '탑승자';
              const needsPreNoticeAck = disclosure.providedAt === null && disclosure.noticeAcknowledgedAt === null;
              const needsPostNoticeAck = disclosure.providedAt !== null && disclosure.postNoticeAcknowledgedAt === null;
              return <li key={disclosure.id}>
                {disclosure.recipientNickname} ({recipientRole}) ·{' '}
                {disclosure.providedAt === null
                  ? `요청 ${new Date(disclosure.requestedAt).toLocaleString('ko-KR')} · ${disclosure.noticeAcknowledgedAt === null ? '알림 확인 전, 위치 미공유' : '알림 확인 완료, 제공 대기'}`
                  : `${new Date(disclosure.providedAt).toLocaleString('ko-KR')} 제공 · 만남 조율`}
                {needsPreNoticeAck && <>
                  <p role="alert">{disclosure.recipientNickname} ({recipientRole})가 {new Date(disclosure.requestedAt).toLocaleString('ko-KR')}에 만남 조율을 위해 위치를 요청했습니다. 확인 전에는 좌표를 공유하지 않습니다.</p>
                  <button type="button" disabled={actionBusy} onClick={() => void acknowledgeLocationDisclosure(disclosure)}>위치 요청 안내 확인</button>
                </>}
                {needsPostNoticeAck && <>
                  <p role="alert">내 위치가 {disclosure.recipientNickname} ({recipientRole})에게 {new Date(disclosure.providedAt!).toLocaleString('ko-KR')}에 만남 조율 목적으로 제공되었습니다.</p>
                  <button type="button" disabled={actionBusy} onClick={() => void acknowledgeLocationDisclosure(disclosure)}>위치 제공 안내 확인</button>
                </>}
              </li>;
            })}
          </ul> : <p>최근 6개월 동안 기록된 위치 제공 내역이 없습니다.</p>}
        </section>
        <form action={(form) => { void updateProfile(form); }}>
          <label>닉네임 <input name="nickname" defaultValue={profile.nickname} maxLength={30} required /></label>
          <label>성별 선택 <select name="gender" defaultValue={profile.gender}><option value="UNDISCLOSED">미공개</option><option value="MAN">남성</option><option value="WOMAN">여성</option><option value="NON_BINARY">논바이너리</option></select></label>
          <button type="submit" disabled={!canUseProfile}>프로필 저장</button>
        </form>
        {profile.affiliation.status !== 'VERIFIED' && <button type="button" disabled={!canUseProfile} onClick={() => void requestVerification()}>학생 확인 요청</button>}
        {profile.driverProfile && <p>차량 확인: {profile.driverProfile.verificationStatus}
          {profile.driverProfile.verifiedUntil ? ` · 유효기간 ${new Date(profile.driverProfile.verifiedUntil).toLocaleDateString('ko-KR')}` : ''}</p>}
        {profile.activeTrip && <section aria-labelledby="active-trip-title">
          <h3 id="active-trip-title">내 운행</h3>
          <p>{profile.activeTrip.originName} → {profile.activeTrip.destinationName}</p>
          <p>출발 {new Date(profile.activeTrip.departureAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 남은 좌석 {profile.activeTrip.remainingSeats}석</p>
          <p>상태: {profile.activeTrip.status}</p>
          <p>운행 ID <code>{profile.activeTrip.id}</code></p>
          <button type="button" onClick={() => void navigator.clipboard.writeText(profile.activeTrip!.id)
            .then(() => setMessage('운행 ID를 복사했습니다.')).catch(() => setMessage('운행 ID를 직접 복사해 주세요.'))}>운행 ID 복사</button>
          {profile.activeTrip.status === 'OPEN' && <div className="actions">
            <button type="button" disabled={actionBusy || !tripRequests.some((item) => item.status === 'BOARDED')
              || tripRequests.some((item) => item.status === 'ACCEPTED')}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/start`, { expectedVersion: profile.activeTrip!.version }, '운행을 시작했습니다.')}>출발</button>
            <button type="button" disabled={actionBusy || tripRequests.some((item) => item.status === 'BOARDED')}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/cancel`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_CANCEL' }, '운행을 취소했습니다.')}>운행 취소</button>
            {tripRequests.some((item) => item.status === 'BOARDED') && <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/abort`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_ABORT' }, '운행을 중단했습니다. 탑승자와 안전을 확인해 주세요.')}>운행 중단</button>}
          </div>}
          {profile.activeTrip.status === 'IN_PROGRESS' && <div className="actions">
            <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/complete`, { expectedVersion: profile.activeTrip!.version }, '운행을 완료했습니다.')}>운행 완료</button>
            <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/abort`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_ABORT' }, '운행을 중단했습니다. 탑승자와 안전을 확인해 주세요.')}>운행 중단</button>
          </div>}
          {['OPEN', 'IN_PROGRESS'].includes(profile.activeTrip.status) && <div aria-live="polite">
            <h4>탑승 요청</h4>
            {tripRequests.length ? <ul>{tripRequests.map((request) => <li key={request.id}>
              <p>{request.riderNickname} · {request.status} · 희망 출발 {new Date(request.desiredDepartureAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
                {request.sameDepartment ? ' · 같은 학과' : ''} · 출발 시각 조건 일치</p>
              {request.status === 'REQUESTED' && !request.conditionsCompatible &&
                <p role="status">현재 동승자의 성별 조건과 맞지 않아 수락할 수 없습니다.</p>}
              {request.status === 'REQUESTED' && <div className="actions">
                <button type="button" disabled={actionBusy || !request.conditionsCompatible} onClick={() => void mutate(`/api/v1/requests/${request.id}/accept`, { expectedVersion: request.version }, '탑승 요청을 수락했습니다.')}>수락</button>
                <button type="button" disabled={actionBusy} onClick={() => void mutate(`/api/v1/requests/${request.id}/reject`, { expectedVersion: request.version }, '탑승 요청을 거절했습니다.')}>거절</button>
              </div>}
              <button type="button" disabled={actionBusy} onClick={() => void blockUser(request.riderId, request.riderNickname)}>이 사용자 차단</button>
              {request.status === 'ACCEPTED' && <>
                <form onSubmit={(event) => {
                  event.preventDefault();
                  const code = new FormData(event.currentTarget).get('code');
                  void boardRequest(request.id, request.version, String(code ?? ''));
                }}>
                  <label>{request.riderNickname}의 탑승 코드 <input name="code" inputMode="numeric" autoComplete="off" minLength={6} maxLength={6} pattern="[0-9]{6}" required /></label>
                  <button type="submit" disabled={actionBusy}>탑승 확인</button>
                </form>
                {Date.now() >= profile.activeTrip!.departureAt + 180_000 && <button type="button" disabled={actionBusy}
                  onClick={() => void mutate(`/api/v1/requests/${request.id}/no-show`, { expectedVersion: request.version }, '미탑승으로 처리했습니다.')}>노쇼 처리</button>}
                {Date.now() < profile.activeTrip!.departureAt && <button type="button" disabled={actionBusy}
                  onClick={() => void mutate(`/api/v1/requests/${request.id}/cancel`, { expectedVersion: request.version, reasonCode: 'DRIVER_CANCEL' }, '확정 요청을 취소했습니다.')}>확정 취소</button>}
              </>}
              <details>
                <summary>이 요청 신고</summary>
                <form onSubmit={(event) => { event.preventDefault(); void submitReport(request.id, new FormData(event.currentTarget)); }}>
                  <label>신고 유형 <input name="category" maxLength={50} required /></label>
                  <label>내용 <textarea name="description" maxLength={2000} required /></label>
                  <button type="submit" disabled={actionBusy}>신고 접수</button>
                </form>
              </details>
            </li>)}</ul> : <p>아직 요청이 없습니다.</p>}
          </div>}
        </section>}
        {profile.activeRequest && <section aria-labelledby="active-request-title">
          <h3 id="active-request-title">내 탑승 요청</h3>
          <p>{profile.activeRequest.driverNickname} · {profile.activeRequest.originName} → {profile.activeRequest.destinationName}</p>
          <p>희망 출발 {new Date(profile.activeRequest.desiredDepartureAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 상태 {profile.activeRequest.status}</p>
          <h4>동승 상대</h4>
          {activePeers.length ? <ul>{activePeers.map((peer) => <li key={peer.userId}>
            {peer.nickname} · {peer.role === 'DRIVER' ? '운전자' : '탑승자'}{' '}
            <button type="button" disabled={actionBusy} onClick={() => void blockUser(peer.userId, peer.nickname)}>차단</button>
          </li>)}</ul> : <p>현재 확인된 다른 동승 상대가 없습니다.</p>}
          {profile.activeRequest.status === 'ACCEPTED' && <>
            <button type="button" disabled={actionBusy} onClick={() => void issueBoardingCode(profile.activeRequest!.id)}>탑승 코드 발급</button>
            {boardingCodes[profile.activeRequest.id] && <p>탑승 코드 <strong>{boardingCodes[profile.activeRequest.id].code}</strong> · 만료 {new Date(boardingCodes[profile.activeRequest.id].expiresAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>}
          </>}
          {['REQUESTED', 'ACCEPTED'].includes(profile.activeRequest.status) && <button type="button" disabled={actionBusy}
            onClick={() => void mutate(`/api/v1/requests/${profile.activeRequest!.id}/cancel`, { expectedVersion: profile.activeRequest!.version, reasonCode: 'RIDER_CANCEL' }, '탑승 요청을 취소했습니다.')}>요청 취소</button>}
          <details>
            <summary>운전자 신고</summary>
            <form onSubmit={(event) => { event.preventDefault(); void submitReport(profile.activeRequest!.id, new FormData(event.currentTarget)); }}>
              <label>신고 유형 <input name="category" maxLength={50} required /></label>
              <label>내용 <textarea name="description" maxLength={2000} required /></label>
              <button type="submit" disabled={actionBusy}>신고 접수</button>
            </form>
          </details>
          <button type="button" disabled={actionBusy}
            onClick={() => void blockUser(profile.activeRequest!.driverId, profile.activeRequest!.driverNickname)}>운전자 차단</button>
        </section>}
        {profile.role === 'STUDENT' && reportableRequests.length > 0 && <section aria-labelledby="reportable-requests-title">
          <h3 id="reportable-requests-title">최근 신고 가능한 동승 관계</h3>
          <ul>{reportableRequests.map((item) => <li key={item.requestId}>
            <p>{item.otherNickname} · 요청 {item.requestStatus} · 운행 {item.tripStatus}</p>
            <button type="button" disabled={actionBusy} onClick={() => void blockUser(item.otherUserId, item.otherNickname)}>이 사용자 차단</button>
            <details>
              <summary>이 관계 신고</summary>
              <form onSubmit={(event) => { event.preventDefault(); void submitReport(item.requestId, new FormData(event.currentTarget)); }}>
                <label>신고 유형 <input name="category" maxLength={50} required /></label>
                <label>내용 <textarea name="description" maxLength={2000} required /></label>
                <button type="submit" disabled={actionBusy}>신고 접수</button>
              </form>
            </details>
          </li>)}</ul>
        </section>}
        {profile.role === 'ADMIN' && <section aria-labelledby="admin-reports-title">
          <h3 id="admin-reports-title">신고 처리</h3>
          {adminReports.length ? <ul>{adminReports.map((report) => <li key={report.id}>
            <p>{report.reporterNickname} → {report.reportedNickname} · {report.category} · {report.status}</p>
            <p>{report.description}</p>
            <p>운행 {report.tripId} · 요청 {report.requestId}</p>
            {report.reportedRole === 'STUDENT' && report.reportedAccountStatus === 'ACTIVE' &&
              <button type="button" disabled={actionBusy} onClick={() => void suspendUser(report.reportedUserId, report.reportedNickname)}>계정 정지</button>}
            {report.status === 'OPEN' && <button type="button" disabled={actionBusy} onClick={() => void updateReport(report.id, 'IN_REVIEW')}>검토 시작</button>}
            {['OPEN', 'IN_REVIEW'].includes(report.status) && <div className="actions">
              <button type="button" disabled={actionBusy} onClick={() => void updateReport(report.id, 'RESOLVED')}>처리 완료</button>
              <button type="button" disabled={actionBusy} onClick={() => void updateReport(report.id, 'DISMISSED')}>기각</button>
            </div>}
          </li>)}</ul> : <p>접수된 신고가 없습니다.</p>}
        </section>}
        {profile.role === 'ADMIN' && <>
          {adminReviewError && <p role="status">{adminReviewError}</p>}
          <section aria-labelledby="admin-catalog-title">
            <h3 id="admin-catalog-title">승차 지점과 노선 관리</h3>
            <p>확인된 학교 지점명과 좌표를 입력해 주세요. 실제 위치는 운영자가 확인해 입력하며 임시값은 활성화하지 마세요. 진행 중인 운행이 연결된 지점·노선은 변경할 수 없습니다.</p>
            {adminCatalogError && <p role="status">{adminCatalogError}</p>}
            <h4>지점 추가</h4>
            <form onSubmit={(event) => { event.preventDefault(); void saveAdminStop(null, new FormData(event.currentTarget)); }}>
              <label>지점 이름 <input name="name" maxLength={80} required /></label>
              <label>종류 <select name="kind" defaultValue="GATE"><option value="GATE">교문</option><option value="DESTINATION">목적지</option></select></label>
              <label>위도 <input name="lat" type="number" min={-90} max={90} step="any" required /></label>
              <label>경도 <input name="lng" type="number" min={-180} max={180} step="any" required /></label>
              <label><input name="active" type="checkbox" defaultChecked /> 활성화</label>
              <button type="submit" disabled={actionBusy}>지점 추가</button>
            </form>
            <h4>등록 지점</h4>
            {adminStops.length ? <ul>{adminStops.map((stop) => <li key={stop.id}>
              <form onSubmit={(event) => { event.preventDefault(); void saveAdminStop(stop.id, new FormData(event.currentTarget)); }}>
                <label>지점 이름 <input name="name" defaultValue={stop.name} maxLength={80} required /></label>
                <label>종류 <select name="kind" defaultValue={stop.kind}><option value="GATE">교문</option><option value="DESTINATION">목적지</option></select></label>
                <label>위도 <input name="lat" type="number" min={-90} max={90} step="any" defaultValue={stop.lat} required /></label>
                <label>경도 <input name="lng" type="number" min={-180} max={180} step="any" defaultValue={stop.lng} required /></label>
                <label><input name="active" type="checkbox" defaultChecked={stop.active === 1} /> 활성화</label>
                <button type="submit" disabled={actionBusy}>지점 저장</button>
              </form>
            </li>)}</ul> : <p>등록된 지점이 없습니다.</p>}
            <h4>노선 추가</h4>
            <form onSubmit={(event) => { event.preventDefault(); void saveAdminRoute(null, new FormData(event.currentTarget)); }}>
              <label>출발 교문 <select name="originStopId" defaultValue="" required>
                <option value="" disabled>교문 선택</option>
                {adminStops.filter((stop) => stop.kind === 'GATE' && stop.active === 1).map((stop) => <option key={stop.id} value={stop.id}>{stop.name}</option>)}
              </select></label>
              <label>목적지 <select name="destinationStopId" defaultValue="" required>
                <option value="" disabled>목적지 선택</option>
                {adminStops.filter((stop) => stop.kind === 'DESTINATION' && stop.active === 1).map((stop) => <option key={stop.id} value={stop.id}>{stop.name}</option>)}
              </select></label>
              <button type="submit" disabled={actionBusy || !adminStops.some((stop) => stop.kind === 'GATE' && stop.active === 1)
                || !adminStops.some((stop) => stop.kind === 'DESTINATION' && stop.active === 1)}>노선 추가</button>
            </form>
            <h4>등록 노선</h4>
            {adminRoutes.length ? <ul>{adminRoutes.map((route) => <li key={route.id}>
              <form onSubmit={(event) => { event.preventDefault(); void saveAdminRoute(route.id, new FormData(event.currentTarget)); }}>
                <p>{route.originName} → {route.destinationName} · {route.active === 1 ? '활성' : '비활성'}</p>
                <label><input name="active" type="checkbox" defaultChecked={route.active === 1} /> 운행 검색에 표시</label>
                <button type="submit" disabled={actionBusy}>노선 상태 저장</button>
              </form>
            </li>)}</ul> : <p>등록된 노선이 없습니다.</p>}
          </section>
          <section aria-labelledby="admin-student-reviews-title">
            <h3 id="admin-student-reviews-title">학생 확인 대기열</h3>
            {adminVerifications.length ? <ul>{adminVerifications.map((request) => <li key={request.id}>
              <p>{request.nickname} · 학과 상태 {request.departmentStatus} · 학과 {request.departmentId ?? '미확인'}</p>
              <p>접수 {new Date(request.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
              <form onSubmit={(event) => { event.preventDefault(); void reviewAdminProfile('student', request.id, 'VERIFIED', new FormData(event.currentTarget)); }}>
                <label>승인 유효기간 (한국 시간) <input name="validUntil" type="datetime-local" min={seoulDateTimeInput(Date.now())} required /></label>
                <div className="actions">
                  <button type="submit" disabled={actionBusy}>학생 확인 승인</button>
                  <button type="button" disabled={actionBusy} onClick={() => void reviewAdminProfile('student', request.id, 'REJECTED')}>거절</button>
                </div>
              </form>
            </li>)}</ul> : <p>대기 중인 학생 확인 요청이 없습니다.</p>}
          </section>
          <section aria-labelledby="admin-driver-reviews-title">
            <h3 id="admin-driver-reviews-title">운전자 차량 확인 대기열</h3>
            {adminDriverProfiles.length ? <ul>{adminDriverProfiles.map((driver) => <li key={driver.userId}>
              <p>{driver.nickname} · {driver.vehicleModel} · {driver.vehicleColor} · 차량 식별 정보 {driver.vehicleIdentifier} · 동승 정원 {driver.passengerCapacity}명</p>
              <form onSubmit={(event) => { event.preventDefault(); void reviewAdminProfile('driver', driver.userId, 'VERIFIED', new FormData(event.currentTarget)); }}>
                <label>승인 유효기간 (한국 시간) <input name="validUntil" type="datetime-local" min={seoulDateTimeInput(Date.now())} required /></label>
                <div className="actions">
                  <button type="submit" disabled={actionBusy}>차량 확인 승인</button>
                  <button type="button" disabled={actionBusy} onClick={() => void reviewAdminProfile('driver', driver.userId, 'REJECTED')}>거절</button>
                </div>
              </form>
            </li>)}</ul> : <p>대기 중인 차량 확인이 없습니다.</p>}
            <p>승인 유효기간은 운영자가 직접 정합니다. 실제 확인 절차와 기간은 학교 운영 기준이 확정되기 전까지 로컬 합성 데이터에만 적용됩니다.</p>
          </section>
        </>}
        {profile.role === 'STUDENT' && <section aria-labelledby="blocked-users-title">
          <h3 id="blocked-users-title">차단한 사용자</h3>
          {blockedUsers.length ? <ul>{blockedUsers.map((user) => <li key={user.userId}>
            {user.nickname} · {new Date(user.createdAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}{' '}
            <button type="button" disabled={actionBusy} onClick={() => void unblockUser(user.userId)}>차단 해제</button>
          </li>)}</ul> : <p>차단한 사용자가 없습니다.</p>}
          <p>차단을 해제해도 종료된 요청이나 운행은 다시 열리지 않습니다.</p>
        </section>}
        {activeLocationContext && <section aria-labelledby="location-title">
          <h3 id="location-title">동승 위치 공유</h3>
          <p>위치 공유는 수락된 운행 관계에서만 작동합니다. 내 위치는 현재 동승 상대에게만 제공되며, 출발·취소·종료·동의 철회 때 삭제됩니다.</p>
          <p>상대 화면에 내 위치가 응답된 시각과 상대, 만남 조율 목적을 기록해 여기에 표시합니다.</p>
          <p>위치 동의는 위 설정에서 관리할 수 있습니다. 위치 공유를 철회하면 현재 좌표가 삭제되고 이후 업로드가 거절됩니다.</p>
          <p>지정 승차 지점: {locationStop?.name ?? (profile.activeActivity?.role === 'DRIVER' ? profile.activeTrip?.originName : profile.activeRequest?.originName)}</p>
          <div className="actions">
            <button type="button" disabled={!locationConsented || consentBusy || locationStarted}
              onClick={() => void startLocationSharing(activeLocationContext)}>내 위치 공유 시작</button>
          </div>
          <p role="status">{locationStatus || (locationConsented ? '위치를 갱신하면 동승 상대에게 실제 제공된 내역을 표시합니다.' : '위치 수집과 상대 제공 동의는 각각 선택할 수 있습니다.')}</p>
          {locationConsented && locationStop && (import.meta.env.VITE_NAVER_MAP_CLIENT_ID?.trim()
            ? <NaverLocationMap clientId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID.trim()} stop={locationStop} own={ownLocation} shared={sharedLocations} />
            : <>
              <p>네이버 지도 Client ID가 설정되지 않아 가상 위치도를 표시합니다.</p>
              <VirtualLocationMap stop={locationStop} own={ownLocation} shared={sharedLocations} />
            </>)}
          {locationConsented && locationStop && <p>승차 지점 좌표: {locationStop.lat.toFixed(5)}, {locationStop.lng.toFixed(5)}</p>}
          {locationConsented && ownLocation && <div>
            <h4>내 위치 · 오차 ±{Math.round(ownLocation.accuracyM)}m</h4>
            <p>{ownLocation.lat.toFixed(5)}, {ownLocation.lng.toFixed(5)} · {locationFreshness(ownLocation.receivedAt)}</p>
            {ownLocation.accuracyM > 100
              ? <p role="status">오차가 커 만남 판단에 적합하지 않습니다. 지정 지점과 탑승 코드를 이용해 주세요.</p>
              : ownLocation.accuracyM > 50 && <p role="status">위치 오차가 있습니다. 지정 지점과 탑승 코드를 이용해 주세요.</p>}
          </div>}
          {locationConsented && sharedLocations.length > 0 ? <ul aria-label="동승 상대 위치">
            {sharedLocations.map((point) => <li key={`${point.role}-${point.sequence}`}>
              <h4>{point.role === 'DRIVER' ? '운전자' : point.nickname} 위치 · 오차 ±{Math.round(point.accuracyM)}m</h4>
              <p>{point.lat.toFixed(5)}, {point.lng.toFixed(5)} · {locationFreshness(point.receivedAt)}</p>
              {point.accuracyM > 100
                ? <p>오차가 커 만남 판단에 적합하지 않습니다. 지정 지점과 탑승 코드를 이용해 주세요.</p>
                : point.accuracyM > 50 && <p>위치 오차가 있습니다. 지정 지점과 탑승 코드를 이용해 주세요.</p>}
            </li>)}
          </ul> : locationConsented && <p>상대 위치가 아직 없거나 60초가 지나 만료되었습니다. 지정 승차 지점에서 만나 탑승 코드를 사용해 주세요.</p>}
        </section>}
        {canRequestRide && !profile.activeActivity && <section aria-labelledby="request-ride-title">
          <h3 id="request-ride-title">운행 검색</h3>
          <form onSubmit={(event) => { event.preventDefault(); void searchTrips(new FormData(event.currentTarget)); }}>
            <label>검색 노선 <select name="routeId" value={searchRouteId} onChange={(event) => setSearchRouteId(event.currentTarget.value)} required>
              <option value="" disabled>노선을 선택해 주세요</option>
              {routes.map((route) => <option key={route.id} value={route.id}>{route.originName} → {route.destinationName}</option>)}
            </select></label>
            <label>희망 출발 시각 (한국 시간) <input name="desiredDepartureAt" type="datetime-local"
              min={seoulDateTimeInput(Date.now())} max={seoulDateTimeInput(Date.now() + 30 * 60_000)}
              defaultValue={seoulDateTimeInput(Date.now() + 5 * 60_000)} required /></label>
            <label>성별 조건 <select name="genderFilter" defaultValue="ANY">
              <option value="ANY">제한 없음</option>
              {profile.gender !== 'UNDISCLOSED' && <><option value="MAN">남성</option><option value="WOMAN">여성</option><option value="SAME_AS_ME">나와 같음</option></>}
            </select></label>
            <label><input name="preferSameDepartment" type="checkbox" /> 같은 학과 우선</label>
            <button type="submit" disabled={searchBusy || !routes.length}>운행 찾기</button>
          </form>
          {tripMatches.length > 0 && <ul aria-label="추천 운행">
            {tripMatches.map((trip) => <li key={trip.id}>
              <p>{trip.driverNickname} · {trip.originName} → {trip.destinationName}</p>
              <p>출발 {new Date(trip.departureAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
                · 남은 좌석 {trip.remainingSeats}석 · 성별 조건 {trip.genderFilter}</p>
              <p>추천 이유: {trip.matchReasons.map((reason) => reason === 'SAME_DEPARTMENT' ? '검증된 같은 학과' : '출발 시각이 가까움').join(' · ')}</p>
              <button type="button" disabled={actionBusy || trip.remainingSeats < 1} onClick={() => void requestMatch(trip)}>탑승 요청</button>
            </li>)}
          </ul>}
          {searchCursor && searchFilters && <button type="button" disabled={searchBusy}
            onClick={() => void loadTrips(searchFilters, searchCursor)}>더 보기</button>}
          {searchBusy && <p role="status">운행을 찾고 있습니다.</p>}
          {!routes.length && <p>검색할 수 있는 노선이 없습니다.</p>}
        </section>}
        {profile.affiliation.status === 'VERIFIED' && <>
          <h3>운전자 차량 등록</h3>
          <p>차량 정보는 본인과 승인 운영자만 볼 수 있습니다. 등록만으로 승인이 되지 않으며, 승인된 차량만 운행에 사용할 수 있습니다.</p>
          <form action={(form) => { void updateDriverProfile(form); }}>
            <label>차량 모델 <input name="vehicleModel" defaultValue={profile.driverProfile?.vehicleModel ?? ''} maxLength={80} required /></label>
            <label>차량 색상 <input name="vehicleColor" defaultValue={profile.driverProfile?.vehicleColor ?? ''} maxLength={30} required /></label>
            <label>차량 식별 정보 <input name="vehicleIdentifier" defaultValue={profile.driverProfile?.vehicleIdentifier ?? ''} maxLength={30} required /></label>
            <label>동승 가능 정원 <select name="passengerCapacity" defaultValue={profile.driverProfile?.passengerCapacity ?? 1}>
              {[1, 2, 3, 4].map((capacity) => <option key={capacity} value={capacity}>{capacity}명</option>)}
            </select></label>
            <button type="submit" disabled={!canRegisterDriver}>차량 정보 저장</button>
          </form>
        </>}
        {canCreateTrip && <>
          <h3>운행 등록</h3>
          <p>출발은 지금부터 30분 이내로 선택해 주세요. 모집은 출발 시각부터 15분 후 마감됩니다.</p>
          {routes.length ? <form onSubmit={(event) => {
            event.preventDefault();
            void createTrip(new FormData(event.currentTarget));
          }}>
            <label>운행 노선 <select name="routeId" defaultValue="" required>
              <option value="" disabled>노선을 선택해 주세요</option>
              {routes.map((route) => <option key={route.id} value={route.id}>{route.originName} → {route.destinationName}</option>)}
            </select></label>
            <label>출발 시각 (한국 시간) <input name="departureAt" type="datetime-local" min={tripDepartureMin} max={tripDepartureMax} required /></label>
            <label>동승 정원 <select name="seatCapacity" defaultValue={Math.min(2, profile.driverProfile!.passengerCapacity)}>
              {Array.from({ length: profile.driverProfile!.passengerCapacity }, (_, index) => index + 1)
                .map((capacity) => <option key={capacity} value={capacity}>{capacity}명</option>)}
            </select></label>
            <label>성별 조건 <select name="genderFilter" defaultValue="ANY">
              <option value="ANY">제한 없음</option>
              {profile.gender !== 'UNDISCLOSED' && <>
                <option value="MAN">남성</option><option value="WOMAN">여성</option><option value="SAME_AS_ME">나와 같음</option>
              </>}
            </select></label>
            <label><input name="preferSameDepartment" type="checkbox" /> 같은 학과 우선</label>
            <button type="submit" disabled={tripBusy || !routes.length}>운행 등록</button>
          </form> : <p>등록할 수 있는 노선이 없습니다.</p>}
        </>}
        {profile.activeActivity?.role === 'RIDER' && <p>탑승 요청이 진행 중입니다. 종료 후 운행을 등록할 수 있습니다.</p>}
        <section aria-labelledby="account-deletion-title">
          <h3 id="account-deletion-title">계정 탈퇴</h3>
          <p>탈퇴는 최근 로그인 후 5분 안에 요청해야 합니다. 진행 중 활동을 종료하고 프로필·로그인 식별 정보와 차량 정보를 제거합니다. 관련 운행·신고·동의·감사 기록과 D1 백업 사본은 즉시 삭제되지 않을 수 있으며 보관기간은 아직 확정되지 않았습니다.</p>
          <button type="button" disabled={actionBusy} onClick={() => void deleteAccount()}>계정 탈퇴</button>
        </section>
        <button type="button" onClick={() => void logout()}>로그아웃</button>
      </> : <>
        <p>{import.meta.env.DEV
          ? '학교 정보가 확인되지 않아 원격 Google 로그인을 사용할 수 없습니다. 로컬 개발은 준비된 합성 계정만 제공합니다.'
          : import.meta.env.VITE_STAGING_AUTH_TEST_ONLY === 'true'
            ? '현재 staging은 학교 Google 계정 확인 전용입니다. 로그인 결과만 보여주며 앱 계정·세션은 만들지 않고 나머지 API는 닫혀 있습니다.'
            : '학교 Google 계정으로 로그인합니다. 현재 이메일 도메인과 Google Workspace 조직을 함께 확인합니다.'}</p>
        {import.meta.env.DEV && <div className="actions">
          <button type="button" onClick={() => void login('driver')}>가상 운전자</button>
          <button type="button" onClick={() => void login('rider')}>가상 탑승자</button>
          <button type="button" onClick={() => void login('pending')}>확인 대기 계정</button>
          <button type="button" onClick={() => void login('admin')}>가상 운영자</button>
        </div>}
        <a href="/api/v1/auth/google/start">학교 Google 로그인</a>
      </>}
      <p aria-live="polite">{message}</p>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
