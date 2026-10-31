import { expect, test } from '@playwright/test';

async function loginDriverWithTrip(page: import('@playwright/test').Page) {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '가상 운전자' }).click();
  const activeTrip = page.getByRole('heading', { name: '내 운행' });
  const driverForm = page.locator('form').filter({ has: page.getByRole('button', { name: '운행 등록' }) });
  const routeSelect = driverForm.getByRole('combobox', { name: '승차 지점·목적지' });
  await expect(page.getByText(/학생 확인: VERIFIED/)).toBeVisible();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await expect.poll(async () => await activeTrip.isVisible() || await routeSelect.isVisible()).toBe(true);
  const created = !await activeTrip.isVisible();
  if (created) {
    await routeSelect.selectOption({ label: 'AI공학관 → 가상 캠퍼스' });
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
  await expect(page.getByText(/로컬 개발용 확인입니다/).first()).toBeVisible();

  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
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
    const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
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
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await page.getByRole('combobox', { name: '대기할 승차 지점·목적지' }).selectOption(routeId);
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

test('driver and rider complete the fixed pickup workflow without GPS sharing', async ({ page, browser, request }) => {
  test.setTimeout(150_000);
  const riderContext = await browser.newContext({ baseURL: 'http://localhost:8787', timezoneId: 'Asia/Seoul' });
  const riderPage = await riderContext.newPage();
  let tripId: string;
  let tripCreated = false;
  let requestCreated = false;

  const acceptRequiredConsents = async (target: import('@playwright/test').Page) => {
    for (const label of [/서비스 이용 약관/, /개인정보 처리방침 확인/]) {
      const checkbox = target.getByRole('checkbox', { name: label });
      if (!await checkbox.isChecked()) await checkbox.check();
    }
  };

  try {
    await page.goto('/onboarding');
    await page.getByRole('button', { name: '가상 운전자' }).click();
    await acceptRequiredConsents(page);
    const activeTrip = page.getByRole('heading', { name: '내 운행' });
    const driverForm = page.locator('form').filter({ has: page.getByRole('button', { name: '운행 등록' }) });
    const driverRoute = driverForm.getByRole('combobox', { name: '승차 지점·목적지' });
    await expect.poll(async () => await activeTrip.isVisible() || await driverRoute.isVisible()).toBe(true);
    if (await activeTrip.isVisible()) {
      const cancel = page.getByRole('button', { name: '운행 취소' });
      if (await cancel.isVisible()) {
        await cancel.click();
        await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
      }
      await expect(driverRoute).toBeVisible();
    }

    await driverRoute.selectOption({ label: 'AI공학관 → 가상 캠퍼스' });
    const routeId = await driverRoute.inputValue();
    const departureAt = Math.ceil(Date.now() / 60_000) * 60_000;
    const departureInput = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(departureAt)).replace(' ', 'T');
    await page.getByLabel('출발 시각 (한국 시간)', { exact: true }).fill(departureInput);
    await page.getByRole('button', { name: '운행 등록' }).click();
    await expect(activeTrip).toBeVisible();
    tripCreated = true;
    tripId = (await page.locator('section[aria-labelledby="active-trip-title"] code').textContent())?.trim() ?? '';
    expect(tripId).toBeTruthy();
    await expect(page.getByRole('heading', { name: '선택한 승차 지점에서 대기' })).toBeVisible();
    await expect(page.getByText(/대기 장소: AI공학관/)).toBeVisible();

    const tripData = await page.evaluate(async (id) => await fetch('/api/v1/trips/' + id, { cache: 'no-store' }).then((response) => response.json()), tripId);
    const actualDepartureAt = (tripData as { data: { departureAt: number } }).data.departureAt;
    await riderPage.goto('/onboarding');
    await riderPage.getByRole('button', { name: '가상 탑승자' }).click();
    await acceptRequiredConsents(riderPage);
    const riderRoute = riderPage.getByRole('combobox', { name: '대기할 승차 지점·목적지' });
    await expect(riderRoute).toBeVisible();
    await expect(riderRoute.locator('option')).toHaveCount(4);
    const pickupOptions = await riderRoute.locator('option').allTextContents();
    for (const stop of ['AI공학관', '중앙도서관', '반도체대학']) {
      expect(pickupOptions.some((label) => label.startsWith(stop + ' →'))).toBe(true);
    }
    expect(pickupOptions.filter((label) => label.includes(' → '))).toHaveLength(3);
    await riderRoute.selectOption(routeId);
    const desiredDeparture = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(actualDepartureAt)).replace(' ', 'T');
    await riderPage.getByLabel('희망 출발 시각 (한국 시간)', { exact: true }).fill(desiredDeparture);
    await riderPage.getByRole('button', { name: '운행 찾기' }).click();
    const matchingTrip = riderPage.getByRole('listitem').filter({ hasText: 'AI공학관 → 가상 캠퍼스' });
    await expect(matchingTrip).toBeVisible();
    await matchingTrip.getByRole('button', { name: '탑승 요청' }).click();
    requestCreated = true;
    await expect(riderPage.getByRole('heading', { name: '내 탑승 요청' })).toBeVisible();
    await expect(riderPage.getByRole('heading', { name: '선택한 승차 지점에서 대기' })).toBeVisible();
    await expect(riderPage.getByText(/대기 장소: AI공학관/)).toBeVisible();
    await expect(riderPage.getByText(/실시간 위치를 수집하거나 서로의 좌표를 공유하지 않습니다/)).toBeVisible();

    const acceptButton = page.getByRole('button', { name: '수락' });
    await expect(acceptButton).toBeVisible({ timeout: 15_000 });
    await acceptButton.click();
    await expect(page.getByText('탑승 요청을 수락했습니다.')).toBeVisible();
    await expect(riderPage.getByText(/상태 ACCEPTED/)).toBeVisible();
    await riderPage.getByRole('button', { name: '탑승 코드 발급' }).click();
    const boardingCode = riderPage.locator('section[aria-labelledby="active-request-title"] strong');
    await expect(boardingCode).toBeVisible();
    const code = (await boardingCode.textContent())?.trim() ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible();
    await codeInput.fill(code);
    await page.getByRole('button', { name: '탑승 확인' }).click();
    await expect(page.getByText('탑승을 확인했습니다. 출발 전에 미탑승 요청을 정리해 주세요.')).toBeVisible();

    await page.waitForTimeout(Math.max(0, actualDepartureAt - Date.now() + 150));
    await page.getByRole('button', { name: '출발', exact: true }).click();
    await expect(page.getByText('운행을 시작했습니다.')).toBeVisible();
    await page.getByRole('button', { name: '운행 완료' }).click();
    await expect(page.getByText('운행을 완료했습니다.')).toBeVisible();

    const health = await request.get('/api/v1/health');
    expect(health.headers()['permissions-policy']).toContain('geolocation=()');
    expect((await request.get('/api/v1/locations/me')).status()).toBe(404);
  } finally {
    if (requestCreated) {
      const cancelRequest = riderPage.getByRole('button', { name: '요청 취소' });
      if (await cancelRequest.isVisible().catch(() => false)) await cancelRequest.click().catch(() => undefined);
    }
    if (tripCreated) {
      const abort = page.getByRole('button', { name: '운행 중단' });
      if (await abort.isVisible().catch(() => false)) {
        await abort.click().catch(() => undefined);
      } else {
        const cancelTrip = page.getByRole('button', { name: '운행 취소' });
        if (await cancelTrip.isVisible().catch(() => false)) await cancelTrip.click().catch(() => undefined);
      }
    }
    await riderContext.close();
  }
});
