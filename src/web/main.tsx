import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { healthResponse } from '../shared/api';
import { devLoginSchema, driverProfileDecisionSchema, driverProfileSchema, profileUpdateSchema, verificationDecisionSchema } from '../shared/auth';
import { adminRouteCreateSchema, adminRouteUpdateSchema, adminStopSchema } from '../shared/admin';
import { reportCreateSchema, suspendUserSchema } from '../shared/moderation';
import { ridePostingCreateSchema } from '../shared/trips';
import './style.css';

function seoulDateTimeInput(timestamp: number) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp)).replace(' ', 'T');
}

type ConsentKind = 'TERMS' | 'PRIVACY';
type ConsentState = { version: string; url: string | null; accepted: boolean };

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
  const [ridePage, setRidePage] = useState<'RIDER' | 'DRIVER'>('RIDER');
  const [searchRouteId, setSearchRouteId] = useState('');
  const [ridePosting, setRidePosting] = useState<{ id: string; routeId: string; desiredDepartureAt: number; expiresAt: number; version: number; originName: string; destinationName: string } | null>(null);
  const [ridePostingList, setRidePostingList] = useState<Array<{ id: string; routeId: string; desiredDepartureAt: number; expiresAt: number; riderNickname: string; originName: string; destinationName: string; sameDepartment: boolean; conditionsCompatible: boolean; matchReasons: Array<'SAME_DEPARTMENT' | 'DEPARTURE_TIME'> }>>([]);
  const [postingBusy, setPostingBusy] = useState(false);
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
  const [boardingCodes, setBoardingCodes] = useState<Record<string, { code: string; expiresAt: number }>>({});
  const [message, setMessage] = useState('');
  const [consentBusy, setConsentBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const postingIdempotency = useRef<{ body: string; key: string } | null>(null);
  const reportKeys = useRef(new Map<string, string>());
  const commandKeys = useRef(new Map<string, string>());
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
  async function refreshRidePosting(revision = profileRevision.current, signal?: AbortSignal) {
    const response = await fetch('/api/v1/ride-postings/mine', { signal, cache: 'no-store' });
    if (!response.ok) return;
    const data = (await response.json() as { data: typeof ridePosting }).data;
    if (revision === profileRevision.current && !signal?.aborted) setRidePosting(data);
  }
  async function refreshRidePostingList(revision = profileRevision.current, signal?: AbortSignal) {
    const response = await fetch('/api/v1/ride-postings', { signal, cache: 'no-store' });
    if (!response.ok) return;
    const data = (await response.json() as { data: typeof ridePostingList }).data;
    if (revision === profileRevision.current && !signal?.aborted) setRidePostingList(data);
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
    if (!input.success) { setMessage('활성 승차 지점과 목적지를 확인해 주세요.'); return; }
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
      await refreshMe();
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
    setMessage('차량 정보를 저장했습니다. 승인된 차량만 탑승 희망을 선택할 수 있습니다.');
  }
  async function createRidePosting(form: FormData) {
    if (!profile || postingBusy || ridePosting) return;
    const input = ridePostingCreateSchema.parse({
      routeId: form.get('routeId'), desiredDepartureAt: Date.parse(`${String(form.get('desiredDepartureAt'))}+09:00`),
      genderFilter: form.get('genderFilter'), preferSameDepartment: form.get('preferSameDepartment') === 'on',
    });
    const body = JSON.stringify(input);
    if (!postingIdempotency.current || postingIdempotency.current.body !== body) {
      postingIdempotency.current = { body, key: crypto.randomUUID() };
    }
    setPostingBusy(true);
    try {
      const response = await fetch('/api/v1/ride-postings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': postingIdempotency.current.key },
        body,
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setMessage(payload?.error?.message ?? '탑승 희망을 등록하지 못했습니다. 조건을 확인해 주세요.');
        return;
      }
      postingIdempotency.current = null;
      await refreshRidePosting();
      setMessage('탑승 희망을 등록했습니다. 운전자가 선택하면 탑승이 확정됩니다.');
    } catch {
      setMessage('연결이 끊겼습니다. 같은 내용으로 다시 시도하면 기존 등록 결과를 확인합니다.');
    } finally {
      setPostingBusy(false);
    }
  }
  async function cancelRidePosting(posting: NonNullable<typeof ridePosting>) {
    const cancelled = await mutate(`/api/v1/ride-postings/${posting.id}/cancel`,
      { expectedVersion: posting.version }, '탑승 희망 등록을 취소했습니다.');
    if (cancelled) setRidePosting(null);
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
    } catch {
      if (revision === profileRevision.current) {
        setProfile(profile);
        setMessage('동의 상태를 저장하지 못했습니다. 최신 안내를 새로고침해 주세요.');
      }
    } finally {
      if (revision === profileRevision.current) setConsentBusy(false);
    }
  }
  async function logout() {
    if (!profile) return;
    const revision = profileRevision.current;
    await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': profile.csrfToken } });
    if (revision !== profileRevision.current) return;
    profileRevision.current += 1;
    setProfile(null);
    setTripRequests([]);
    setConsentBusy(false);
    setRidePosting(null);
    setRidePostingList([]);
    setPostingBusy(false);
    setMessage('로그아웃했습니다.');
  }
  async function deleteAccount() {
    if (!profile || actionBusy || !window.confirm('계정을 탈퇴할까요? 직접 식별정보를 정리하고 진행 중 운행·요청을 종료합니다. 일부 운행·신고·동의 기록은 정해진 기간 보관됩니다. D1 복구 창 안에 삭제 전 정보가 되살아날 수 있어 복구 시 탈퇴 기록을 다시 적용합니다.')) return;
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
      setProfile(null); setTripRequests([]);
      setBoardingCodes({});
      setMessage('계정 탈퇴를 처리했습니다. 연결된 일부 기록은 정해진 기간 보관되며 D1 복구 창에서는 삭제 전 상태가 복원될 수 있습니다.');
    } catch {
      setMessage('연결이 끊겼습니다. 로그인 여부를 확인해 탈퇴 결과를 확인해 주세요.');
    } finally {
      setActionBusy(false);
    }
  }
  const canUseProfile = Boolean(!consentBusy && profile?.requiredConsents.TERMS.accepted && profile.requiredConsents.PRIVACY.accepted);
  const canRegisterDriver = Boolean(canUseProfile && profile?.role === 'STUDENT' && profile.affiliation.status === 'VERIFIED'
    && (profile.affiliation.verifiedUntil ?? 0) > Date.now());
  const hasBlockingActivity = Boolean(profile?.activeActivity
    && !(profile.activeActivity.role === 'DRIVER' && profile.activeTrip?.status === 'EXPIRED'));
  const driverVerified = Boolean(canRegisterDriver && profile?.driverProfile?.verificationStatus === 'VERIFIED'
    && (profile.driverProfile.verifiedUntil ?? 0) > Date.now());
  const canSelectPosting = Boolean(driverVerified && (!hasBlockingActivity
    || (profile?.activeActivity?.role === 'DRIVER' && profile.activeTrip?.status === 'OPEN' && profile.activeTrip.remainingSeats > 0)));
  const canRequestRide = Boolean(canRegisterDriver && !hasBlockingActivity);
  const canPostRide = Boolean(canRequestRide && !ridePosting);
  const waitingPoint = profile?.activeActivity?.role === 'DRIVER'
    ? profile.activeTrip?.originName
    : profile?.activeRequest?.originName;
  const desiredDepartureMin = seoulDateTimeInput(Date.now());
  const desiredDepartureMax = seoulDateTimeInput(Date.now() + 30 * 60_000);
  useEffect(() => {
    setRidePage('RIDER');
    setRidePosting(null);
    setRidePostingList([]);
  }, [profile?.id]);
  useEffect(() => {
    if (profile?.activeActivity?.role === 'DRIVER') setRidePage('DRIVER');
    if (profile?.activeActivity?.role === 'RIDER') setRidePage('RIDER');
  }, [profile?.activeActivity?.role]);
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
    if (!profile || profile.role !== 'STUDENT' || ridePage !== 'RIDER' || profile.activeActivity || !canRequestRide) {
      setRidePosting(null);
      return;
    }
    let stopped = false;
    let loading = false;
    const revision = profileRevision.current;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || loading || revision !== profileRevision.current || document.visibilityState !== 'visible') return;
      loading = true;
      try {
        const me = await fetch('/api/v1/me', { signal: controller.signal, cache: 'no-store' });
        if (me.ok && !stopped && revision === profileRevision.current) {
          const data = (await me.json() as { data: typeof profile }).data;
          setProfile(data);
          if (data?.activeActivity) return;
        }
        await refreshRidePosting(revision, controller.signal);
      } catch {
        // Keep the last server state visible during a temporary connection failure.
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [profile?.id, profile?.activeActivity?.role, ridePage, canRequestRide]);
  useEffect(() => {
    if (!profile || profile.role !== 'STUDENT' || ridePage !== 'DRIVER' || !driverVerified) {
      setRidePostingList([]);
      return;
    }
    let stopped = false;
    let loading = false;
    const revision = profileRevision.current;
    const controller = new AbortController();
    const poll = async () => {
      if (stopped || loading || revision !== profileRevision.current || document.visibilityState !== 'visible') return;
      loading = true;
      try { await refreshRidePostingList(revision, controller.signal); } catch {
        // Keep the last server state visible during a temporary connection failure.
      } finally { loading = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => { stopped = true; window.clearInterval(timer); controller.abort(); };
  }, [profile?.id, profile?.driverProfile?.verificationStatus, ridePage, driverVerified, profile?.activeTrip?.id]);
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
  return <main>
    <p className="eyebrow">CAMPUS RIDE / LOCAL DEVELOPMENT</p>
    <h1>함께 올라가는<br />캠퍼스의 시작.</h1>
    <p>등록된 승차 지점에서 함께 이동할 학생들을 연결하는 동승 서비스입니다.</p>
    <section aria-labelledby="development-title">
      <h2 id="development-title">개발 환경 준비 중</h2>
      <p role="status">{status}</p>
      <p aria-live="polite">{message}</p>
      {profile ? <>
        <h3>{profile.nickname}</h3>
        <p>학생 확인: {profile.affiliation.status} · 학과: {profile.department.status}</p>
        {profile.role === 'STUDENT' && <nav className="ride-page-nav" aria-label="동승 이용 화면">
          <button type="button" aria-pressed={ridePage === 'RIDER'}
            disabled={hasBlockingActivity && profile.activeActivity?.role === 'DRIVER'} onClick={() => setRidePage('RIDER')}>탑승자 페이지</button>
          <button type="button" aria-pressed={ridePage === 'DRIVER'}
            disabled={hasBlockingActivity && profile.activeActivity?.role === 'RIDER'} onClick={() => setRidePage('DRIVER')}>운전자 페이지</button>
        </nav>}
        {profile.role === 'STUDENT' && <div className="ride-page-intro">
          <h2>{ridePage === 'RIDER' ? '탑승자 페이지' : '운전자 페이지'}</h2>
          <p>{ridePage === 'RIDER'
            ? '승차 지점과 희망 시각을 등록하면 운전자가 선택해 탑승을 확정합니다.'
            : '승인된 차량으로 탑승 희망을 살펴보고 운행을 선택합니다.'}</p>
        </div>}
        <section aria-labelledby="consent-title">
          <h3 id="consent-title">약관·개인정보 확인</h3>
          <p>{import.meta.env.VITE_STAGING_TEST_API_ENABLED === 'true'
            ? '임시 기술 테스트입니다. Google 계정 식별자·이메일·프로필·요청/운행 기록이 staging D1에 저장되며, 삭제 후 복구 사본에 최대 7일 남을 수 있습니다. 아래 확인은 실제 약관이나 개인정보 처리방침 동의가 아닙니다. 단말 GPS와 실시간 좌표는 수집하지 않습니다.'
            : '서비스 이용약관 확인과 개인정보 처리방침 확인이 필요합니다. 처리방침 확인은 별도의 개인정보 처리 동의를 대신하지 않습니다. 현재는 단말 GPS를 수집하거나 동승 상대에게 실시간 좌표를 제공하지 않습니다.'}</p>
          {(['TERMS', 'PRIVACY'] as const).map((kind) => {
            const policy = profile.requiredConsents[kind];
            const title = import.meta.env.VITE_STAGING_TEST_API_ENABLED === 'true'
              ? kind === 'TERMS' ? '임시 테스트 이용 안내' : '임시 테스트 데이터 처리 안내'
              : kind === 'TERMS' ? '서비스 이용 약관' : '개인정보 처리방침 확인';
            return <div className="consent-row" key={kind}>
              <label><input type="checkbox" checked={policy.accepted} disabled={consentBusy}
                onChange={(event) => void updateConsent(kind, event.currentTarget.checked)} /> {title} ({policy.version})</label>
              {policy.url ? <a href={policy.url} target="_blank" rel="noreferrer">내용 보기</a>
                : <p>{import.meta.env.VITE_STAGING_TEST_API_ENABLED === 'true'
                  ? '임시 기술 검증용 확인이며 실제 서비스 약관·개인정보 처리방침이 아닙니다.'
                  : '로컬 개발용 확인입니다. 실제 약관이나 개인정보 처리 안내가 아니며 합성 계정만 사용합니다.'}</p>}
            </div>;
          })}
        </section>
        <form action={(form) => { void updateProfile(form); }}>
          <label>닉네임 <input name="nickname" defaultValue={profile.nickname} maxLength={30} required /></label>
          <label>성별 선택 <select name="gender" defaultValue={profile.gender}><option value="UNDISCLOSED">미공개</option><option value="MAN">남성</option><option value="WOMAN">여성</option><option value="NON_BINARY">논바이너리</option></select></label>
          <button type="submit" disabled={!canUseProfile}>프로필 저장</button>
        </form>
        {profile.affiliation.status !== 'VERIFIED' && <button type="button" disabled={!canUseProfile} onClick={() => void requestVerification()}>학생 확인 요청</button>}
        {ridePage === 'DRIVER' && profile.driverProfile && <p>차량 확인: {profile.driverProfile.verificationStatus}
          {profile.driverProfile.verifiedUntil ? ` · 유효기간 ${new Date(profile.driverProfile.verifiedUntil).toLocaleDateString('ko-KR')}` : ''}</p>}
        {ridePage === 'DRIVER' && profile.activeTrip && <section aria-labelledby="active-trip-title">
          <h3 id="active-trip-title">내 운행</h3>
          <p>{profile.activeTrip.originName} → {profile.activeTrip.destinationName}</p>
          <p>출발 {new Date(profile.activeTrip.departureAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 남은 좌석 {profile.activeTrip.remainingSeats}석</p>
          <p>상태: {profile.activeTrip.status}</p>
          <p>운행 ID <code>{profile.activeTrip.id}</code></p>
          <button type="button" onClick={() => void navigator.clipboard.writeText(profile.activeTrip!.id)
            .then(() => setMessage('운행 ID를 복사했습니다.')).catch(() => setMessage('운행 ID를 직접 복사해 주세요.'))}>운행 ID 복사</button>
          {profile.activeTrip.status === 'OPEN' && <div className="actions">
            <button type="button" disabled={actionBusy || Date.now() < profile.activeTrip.departureAt
              || !tripRequests.some((item) => item.status === 'BOARDED')
              || tripRequests.some((item) => item.status === 'ACCEPTED')}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/start`, { expectedVersion: profile.activeTrip!.version }, '운행을 시작했습니다.')}>출발</button>
            <button type="button" disabled={actionBusy || tripRequests.some((item) => item.status === 'BOARDED')}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/cancel`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_CANCEL' }, '운행을 취소했습니다.')}>운행 취소</button>
            {tripRequests.some((item) => item.status === 'BOARDED') && <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/abort`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_ABORT' }, '운행을 중단했습니다. 탑승자와 안전을 확인해 주세요.')}>운행 중단</button>}
          </div>}
          {profile.activeTrip.status === 'OPEN' && Date.now() < profile.activeTrip.departureAt
            && <p>출발 예정 시각이 되고 탑승 확인이 끝나면 출발할 수 있습니다.</p>}
          {profile.activeTrip.status === 'IN_PROGRESS' && <div className="actions">
            <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/complete`, { expectedVersion: profile.activeTrip!.version }, '운행을 완료했습니다.')}>운행 완료</button>
            <button type="button" disabled={actionBusy}
              onClick={() => void mutate(`/api/v1/trips/${profile.activeTrip!.id}/abort`, { expectedVersion: profile.activeTrip!.version, reasonCode: 'DRIVER_ABORT' }, '운행을 중단했습니다. 탑승자와 안전을 확인해 주세요.')}>운행 중단</button>
          </div>}
          {['OPEN', 'IN_PROGRESS'].includes(profile.activeTrip.status) && <div aria-live="polite">
            <h4>확정된 탑승자</h4>
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
        {ridePage === 'RIDER' && profile.activeRequest && <section aria-labelledby="active-request-title">
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
              <label>종류 <select name="kind" defaultValue="GATE"><option value="GATE">승차 지점</option><option value="DESTINATION">목적지</option></select></label>
              <label>위도 <input name="lat" type="number" min={-90} max={90} step="any" required /></label>
              <label>경도 <input name="lng" type="number" min={-180} max={180} step="any" required /></label>
              <label><input name="active" type="checkbox" defaultChecked /> 활성화</label>
              <button type="submit" disabled={actionBusy}>지점 추가</button>
            </form>
            <h4>등록 지점</h4>
            {adminStops.length ? <ul>{adminStops.map((stop) => <li key={stop.id}>
              <form onSubmit={(event) => { event.preventDefault(); void saveAdminStop(stop.id, new FormData(event.currentTarget)); }}>
                <label>지점 이름 <input name="name" defaultValue={stop.name} maxLength={80} required /></label>
                <label>종류 <select name="kind" defaultValue={stop.kind}><option value="GATE">승차 지점</option><option value="DESTINATION">목적지</option></select></label>
                <label>위도 <input name="lat" type="number" min={-90} max={90} step="any" defaultValue={stop.lat} required /></label>
                <label>경도 <input name="lng" type="number" min={-180} max={180} step="any" defaultValue={stop.lng} required /></label>
                <label><input name="active" type="checkbox" defaultChecked={stop.active === 1} /> 활성화</label>
                <button type="submit" disabled={actionBusy}>지점 저장</button>
              </form>
            </li>)}</ul> : <p>등록된 지점이 없습니다.</p>}
            <h4>노선 추가</h4>
            <form onSubmit={(event) => { event.preventDefault(); void saveAdminRoute(null, new FormData(event.currentTarget)); }}>
              <label>승차 지점 <select name="originStopId" defaultValue="" required>
                <option value="" disabled>승차 지점 선택</option>
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
        {waitingPoint && profile.activeActivity?.role === (ridePage === 'DRIVER' ? 'DRIVER' : 'RIDER') && <section aria-labelledby="waiting-point-title">
          <h3 id="waiting-point-title">선택한 승차 지점에서 대기</h3>
          <p>대기 장소: <strong>{waitingPoint}</strong></p>
          <p>실시간 위치를 수집하거나 서로의 좌표를 공유하지 않습니다. 운전자와 탑승자는 이 승차 지점에서 만나고, 현장에서 탑승 코드를 확인합니다. 앱은 도착 여부를 추적하거나 자동으로 판정하지 않습니다.</p>
        </section>}
        {ridePage === 'RIDER' && ridePosting && <section aria-labelledby="ride-posting-title">
          <h3 id="ride-posting-title">운전자 선택 대기</h3>
          <p>{ridePosting.originName} → {ridePosting.destinationName}</p>
          <p>희망 출발 {new Date(ridePosting.desiredDepartureAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 출발 시각까지 운전자를 기다립니다.</p>
          <p>운전자가 선택하면 탑승이 확정되고 차량 정보와 탑승 코드가 열립니다.</p>
          <button type="button" disabled={actionBusy} onClick={() => void cancelRidePosting(ridePosting)}>탑승 희망 취소</button>
        </section>}
        {ridePage === 'RIDER' && canPostRide && <section aria-labelledby="request-ride-title">
          <h3 id="request-ride-title">탑승 희망 등록</h3>
          <p>승차 지점과 희망 시각을 올리면 승인된 운전자가 골라 탑승을 확정합니다.</p>
          <form onSubmit={(event) => { event.preventDefault(); void createRidePosting(new FormData(event.currentTarget)); }}>
            <label>대기할 승차 지점·목적지 <select name="routeId" value={searchRouteId} onChange={(event) => setSearchRouteId(event.currentTarget.value)} required>
              <option value="" disabled>승차 지점과 목적지를 선택해 주세요</option>
              {routes.map((route) => <option key={route.id} value={route.id}>{route.originName} → {route.destinationName}</option>)}
            </select></label>
            <label>희망 출발 시각 (한국 시간) <input name="desiredDepartureAt" type="datetime-local"
              min={desiredDepartureMin} max={desiredDepartureMax}
              defaultValue={seoulDateTimeInput(Date.now() + 5 * 60_000)} required /></label>
            <label>성별 조건 <select name="genderFilter" defaultValue="ANY">
              <option value="ANY">제한 없음</option>
              {profile.gender !== 'UNDISCLOSED' && <><option value="MAN">남성</option><option value="WOMAN">여성</option><option value="SAME_AS_ME">나와 같음</option></>}
            </select></label>
            <label><input name="preferSameDepartment" type="checkbox" /> 같은 학과 우선</label>
            <button type="submit" disabled={postingBusy || !routes.length}>탑승 희망 등록</button>
          </form>
          {!routes.length && <p>등록할 수 있는 노선이 없습니다.</p>}
        </section>}
        {ridePage === 'DRIVER' && profile.affiliation.status === 'VERIFIED' && <>
          <h3>운전자 차량 등록</h3>
          <p>차량 정보는 본인과 승인 운영자만 볼 수 있습니다. 등록만으로 승인이 되지 않으며, 승인 차량만 탑승 희망을 선택할 수 있습니다.</p>
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
        {ridePage === 'DRIVER' && <section aria-labelledby="ride-postings-list-title">
          <h3 id="ride-postings-list-title">탑승 희망 선택</h3>
          {!driverVerified && <p>차량 등록과 운영자 승인이 완료되면 탑승 희망을 볼 수 있습니다.</p>}
          {driverVerified && !canSelectPosting && profile.activeActivity?.role === 'RIDER'
            && <p>탑승자 활동이 끝난 뒤 탑승 희망을 선택할 수 있습니다.</p>}
          {driverVerified && canSelectPosting && ridePostingList.length > 0
            ? <ul aria-label="탑승 희망 목록">{ridePostingList.map((posting) => <li key={posting.id}>
              <p>{posting.riderNickname} · {posting.originName} → {posting.destinationName}</p>
              <p>희망 출발 {new Date(posting.desiredDepartureAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
                {posting.sameDepartment ? ' · 같은 학과' : ''}</p>
              {!posting.conditionsCompatible && <p role="status">현재 운행 구성원의 성별 조건과 맞지 않습니다.</p>}
              <button type="button" disabled={actionBusy || !posting.conditionsCompatible || !canSelectPosting}
                onClick={() => void mutate(`/api/v1/ride-postings/${posting.id}/accept`, {}, '탑승 희망을 선택했습니다. 탑승이 확정됐습니다.')}>선택 및 수락</button>
            </li>)}</ul>
            : driverVerified && canSelectPosting && <p role="status">선택할 수 있는 탑승 희망이 없습니다.</p>}
        </section>}
        <section aria-labelledby="account-deletion-title">
          <h3 id="account-deletion-title">계정 탈퇴</h3>
          <p>탈퇴는 최근 로그인 후 5분 안에 요청해야 합니다. 진행 중 활동을 종료하고 프로필·로그인 식별 정보와 차량 정보를 제거합니다. 관련 운행·신고·동의·감사 기록과 D1 백업 사본은 즉시 삭제되지 않을 수 있으며 보관기간은 아직 확정되지 않았습니다.</p>
          <button type="button" disabled={actionBusy} onClick={() => void deleteAccount()}>계정 탈퇴</button>
        </section>
        <button type="button" onClick={() => void logout()}>로그아웃</button>
      </> : <>
        <p>{import.meta.env.DEV
          ? '학교 정보가 확인되지 않아 원격 Google 로그인을 사용할 수 없습니다. 로컬 개발은 준비된 합성 계정만 제공합니다.'
          : import.meta.env.VITE_STAGING_TEST_API_ENABLED === 'true'
            ? '임시 staging 테스트 중입니다. Google 계정 확인 후 지정된 두 계정만 앱 API를 사용할 수 있습니다.'
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
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
