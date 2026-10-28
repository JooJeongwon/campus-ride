import { expect, test } from '@playwright/test';

async function loginDriverWithTrip(page: import('@playwright/test').Page) {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '가상 운전자' }).click();
  const activeTrip = page.getByRole('heading', { name: '내 운행' });
  const routeSelect = page.getByLabel('운행 노선');
  await expect(page.getByText(/학생 확인: VERIFIED/)).toBeVisible();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리 안내/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await expect.poll(async () => await activeTrip.isVisible() || await routeSelect.isVisible()).toBe(true);
  const created = !await activeTrip.isVisible();
  if (created) {
    await routeSelect.selectOption({ index: 1 });
    const departure = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(Date.now() + 5 * 60_000)).replace(' ', 'T');
    await page.getByLabel('출발 시각 (한국 시간)', { exact: true }).fill(departure);
    await page.getByRole('button', { name: '운행 등록' }).click();
  }
  await expect(page.getByRole('heading', { name: '내 운행' })).toBeVisible();
  const id = (await page.locator('section[aria-labelledby="active-trip-title"] code').textContent())?.trim() ?? '';
  return { id, created: created || id !== '50000000-0000-4000-8000-000000000001' };
}

test('direct SPA navigation reaches the same-origin Worker and D1', async ({ page, request }) => {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('함께 올라가는');
  await expect(page.getByRole('status')).toHaveText('로컬 Worker · D1 연결 정상');
  const protectedResponse = await request.get('/api/v1/me');
  expect(protectedResponse.status()).toBe(401);
  const missing = await request.get('/api/v1/missing');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
});

test('onboarding requires separate current terms and privacy consent', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '확인 대기 계정' }).click();
  await expect(page.getByText(/학생 확인: PENDING/)).toBeVisible();
  await expect(page.getByText(/로컬 개발용 동의 체험/).first()).toBeVisible();

  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리 안내/ });
  const saveProfile = page.getByRole('button', { name: '프로필 저장' });
  if (await terms.isChecked()) await terms.uncheck();
  if (await privacy.isChecked()) await privacy.uncheck();
  await expect(saveProfile).toBeDisabled();
  await terms.check();
  await privacy.check();
  await expect(terms).toBeChecked();
  await expect(privacy).toBeChecked();
  await expect(saveProfile).toBeEnabled();

  await page.getByRole('textbox', { name: '닉네임' }).fill('동의 회귀 확인');
  await saveProfile.click();
  await expect(page.getByText('프로필을 저장했습니다.')).toBeVisible();
  await privacy.uncheck();
  await expect(privacy).not.toBeChecked();
  await expect(saveProfile).toBeDisabled();
});

test('a verified student can submit vehicle details for review', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '가상 탑승자' }).click();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리 안내/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await page.getByRole('textbox', { name: '차량 모델' }).fill('합성 하이브리드');
  await page.getByRole('textbox', { name: '차량 색상' }).fill('은색');
  await page.getByRole('textbox', { name: '차량 식별 정보' }).fill('SYNTHETIC-E2E');
  await page.getByLabel('동승 가능 정원').selectOption('2');
  await page.getByRole('button', { name: '차량 정보 저장' }).click();
  await expect(page.getByText('차량 정보를 저장했습니다. 승인 전에는 운행을 만들 수 없습니다.')).toBeVisible();
  await expect(page.getByText('차량 확인: PENDING')).toBeVisible();
});

test('a driver can read their active trip from the server after login', async ({ page }) => {
  const trip = await loginDriverWithTrip(page);
  await expect(page.getByRole('heading', { name: '내 운행' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="active-trip-title"] code')).not.toBeEmpty();
  if (trip.created) {
    await page.getByRole('button', { name: '운행 취소' }).click();
    await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
  }
});

test('a rider can request a shared trip and cancel it from the active request screen', async ({ page }) => {
  const tripHandle = await loginDriverWithTrip(page);
  const tripId = tripHandle.id;
  expect(tripId).toBeTruthy();
  let requestActive = false;
  try {
  const tripData = await page.evaluate(async (id) => await fetch(`/api/v1/trips/${id}`, { cache: 'no-store' }).then((response) => response.json()), tripId);
  const departureAt = (tripData as { data: { departureAt: number; routeId: string } }).data.departureAt;
  const routeId = (tripData as { data: { routeId: string } }).data.routeId;
  const desiredDeparture = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(departureAt)).replace(' ', 'T');

  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByRole('button', { name: '가상 탑승자' }).click();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리 안내/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await page.getByRole('combobox', { name: '검색 노선' }).selectOption(routeId);
  await page.getByLabel('희망 출발 시각 (한국 시간)', { exact: true }).fill(desiredDeparture);
  await page.getByRole('button', { name: '운행 찾기' }).click();
  await expect(page.getByText('추천 이유: 검증된 같은 학과 · 출발 시각이 가까움')).toBeVisible();
  await page.getByRole('button', { name: '탑승 요청' }).click();
  requestActive = true;
  await expect(page.getByRole('heading', { name: '내 탑승 요청' })).toBeVisible();
  await expect(page.getByText('탑승 요청을 보냈습니다.')).toBeVisible();
  await page.getByRole('button', { name: '요청 취소' }).click();
  await expect(page.getByText('탑승 요청을 취소했습니다.')).toBeVisible();
  requestActive = false;
  await expect(page.getByRole('heading', { name: '최근 신고 가능한 동승 관계' })).toBeVisible();
  const reportableSection = page.locator('section[aria-labelledby="reportable-requests-title"]');
  await reportableSection.locator('summary').first().click();
  await reportableSection.getByRole('textbox', { name: '신고 유형' }).fill('안전');
  await reportableSection.getByRole('textbox', { name: '내용' }).fill('합성 E2E 신고 내용');
  await reportableSection.getByRole('button', { name: '신고 접수' }).click();
  await expect(page.getByText('신고를 접수했습니다. 신고 내용은 운영자만 확인할 수 있습니다.')).toBeVisible();
  if (tripHandle.created) {
    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 운전자' }).click();
    await page.getByRole('button', { name: '운행 취소' }).click();
    await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
  }
  } finally {
    if (requestActive || tripHandle.created) {
      const logout = page.getByRole('button', { name: '로그아웃' });
      if (await logout.isVisible().catch(() => false)) await logout.click();
      if (requestActive) {
        await page.getByRole('button', { name: '가상 탑승자' }).click();
        const cancel = page.getByRole('button', { name: '요청 취소' });
        if (await cancel.isVisible().catch(() => false)) {
          await cancel.click();
          await expect(page.getByText('탑승 요청을 취소했습니다.')).toBeVisible();
        }
        await page.getByRole('button', { name: '로그아웃' }).click();
      }
      if (tripHandle.created) {
        await page.getByRole('button', { name: '가상 운전자' }).click();
        const cancelTrip = page.getByRole('button', { name: '운행 취소' });
        if (await cancelTrip.isVisible().catch(() => false)) {
          await cancelTrip.click();
          await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
        }
      }
    }
  }
});

test('accepted riders can share browser locations only with their driver', async ({ page }) => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 37.5, longitude: 127, accuracy: 75 });
  const trip = await loginDriverWithTrip(page);
  const tripId = trip.id;
  let requestActive = false;

  try {
    const tripData = await page.evaluate(async (id) => await fetch(`/api/v1/trips/${id}`, { cache: 'no-store' }).then((response) => response.json()), tripId);
    const departureAt = (tripData as { data: { departureAt: number; routeId: string } }).data.departureAt;
    const routeId = (tripData as { data: { routeId: string } }).data.routeId;
    const desiredDeparture = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(departureAt)).replace(' ', 'T');

    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 탑승자' }).click();
    const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
    const privacy = page.getByRole('checkbox', { name: /개인정보 처리 안내/ });
    if (!await terms.isChecked()) await terms.check();
    if (!await privacy.isChecked()) await privacy.check();
    await page.getByRole('combobox', { name: '검색 노선' }).selectOption(routeId);
    await page.getByLabel('희망 출발 시각 (한국 시간)', { exact: true }).fill(desiredDeparture);
    await page.getByRole('button', { name: '운행 찾기' }).click();
    await page.getByRole('button', { name: '탑승 요청' }).click();
    requestActive = true;
    await expect(page.getByText('탑승 요청을 보냈습니다.')).toBeVisible();

    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 운전자' }).click();
    await page.getByRole('button', { name: '수락' }).click();
    await expect(page.getByText('탑승 요청을 수락했습니다.')).toBeVisible();
    await expect(page.getByRole('heading', { name: '동승 위치 공유' })).toBeVisible();
    let driverConsentChanged = false;
    for (const label of [/내 위치를 임시 수집/, /내 위치를 동승 상대에게 제공/]) {
      const consent = page.getByRole('checkbox', { name: label });
      if (!await consent.isChecked()) { await consent.check(); driverConsentChanged = true; }
    }
    if (driverConsentChanged) await expect(page.getByText('동의 상태를 저장했습니다.')).toBeVisible();
    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 탑승자' }).click();
    await expect(page.getByRole('heading', { name: '동승 위치 공유' })).toBeVisible();
    let riderConsentChanged = false;
    for (const label of [/내 위치를 임시 수집/, /내 위치를 동승 상대에게 제공/]) {
      const consent = page.getByRole('checkbox', { name: label });
      if (!await consent.isChecked()) { await consent.check(); riderConsentChanged = true; }
    }
    if (riderConsentChanged) await expect(page.getByText('동의 상태를 저장했습니다.')).toBeVisible();
    await page.getByRole('button', { name: '내 위치 공유 시작' }).click();
    await expect(page.getByText('위치 오차가 있습니다. 지정 승차 지점에서 만나 주세요.')).toBeVisible();
    await expect(page.getByRole('img', { name: '가상 위치도' })).toBeVisible();

    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 운전자' }).click();
    await expect(page.getByRole('heading', { name: '동승 위치 공유' })).toBeVisible();
    await page.getByRole('button', { name: '내 위치 공유 시작' }).click();
    await expect(page.getByText('위치 오차가 있습니다. 지정 승차 지점에서 만나 주세요.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /가상 탑승자 위치 · 오차/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('img', { name: '가상 위치도' })).toBeVisible();

    await page.getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('button', { name: '가상 탑승자' }).click();
    await expect(page.getByRole('heading', { name: /운전자 위치 · 오차/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('img', { name: '가상 위치도' })).toBeVisible();
    await expect(page.locator('.virtual-map__accuracy')).toHaveCount(2);
    await expect(page.getByText(/37\.50000, 127\.00000/).first()).toBeVisible();

    await page.getByRole('button', { name: '요청 취소' }).click();
    await expect(page.getByText('탑승 요청을 취소했습니다.')).toBeVisible();
    requestActive = false;
  } finally {
    if (requestActive || trip.created) {
      const logout = page.getByRole('button', { name: '로그아웃' });
      if (await logout.isVisible().catch(() => false)) await logout.click();
      if (requestActive) {
        await page.getByRole('button', { name: '가상 탑승자' }).click();
        const cancel = page.getByRole('button', { name: '요청 취소' });
        if (await cancel.isVisible().catch(() => false)) {
          await cancel.click();
          await expect(page.getByText('탑승 요청을 취소했습니다.')).toBeVisible();
        }
        await page.getByRole('button', { name: '로그아웃' }).click();
      }
      if (trip.created) {
        await page.getByRole('button', { name: '가상 운전자' }).click();
        const cancelTrip = page.getByRole('button', { name: '운행 취소' });
        if (await cancelTrip.isVisible().catch(() => false)) {
          await cancelTrip.click();
          await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
        }
      }
    }
  }
});
