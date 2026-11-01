import { expect, test } from '@playwright/test';

async function loginDriverWithTrip(page: import('@playwright/test').Page) {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '가상 운전자' }).click();
  await expect(page.getByText(/학생 확인: VERIFIED/)).toBeVisible();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await page.getByRole('button', { name: '운전자 페이지' }).click();
  const activeOpen = await page.getByText('상태: OPEN', { exact: true }).isVisible().catch(() => false);
  const created = !activeOpen;
  if (created) {
    const result = await page.evaluate(async () => {
      const [meResponse, routesResponse] = await Promise.all([
        fetch('/api/v1/me', { cache: 'no-store' }), fetch('/api/v1/routes', { cache: 'no-store' }),
      ]);
      const me = (await meResponse.json() as { data: { csrfToken: string } }).data;
      const routes = (await routesResponse.json() as { data: Array<{ id: string; originName: string; destinationName: string }> }).data;
      const route = routes.find((item) => item.originName === 'AI공학관' && item.destinationName === '가상 캠퍼스');
      if (!route) return false;
      const response = await fetch('/api/v1/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ routeId: route.id, departureAt: Math.ceil((Date.now() + 60_000) / 60_000) * 60_000,
          seatCapacity: 2, genderFilter: 'ANY', preferSameDepartment: false }),
      });
      return response.ok;
    });
    expect(result).toBe(true);
    await page.reload();
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
  await expect(page.getByRole('heading', { name: '탑승 희망 등록' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '운전자 차량 등록' })).not.toBeVisible();
  await page.getByRole('button', { name: '운전자 페이지' }).click();
  await expect(page.getByRole('heading', { name: '운전자 페이지' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '탑승 희망 등록' })).not.toBeVisible();
  await page.getByRole('textbox', { name: '차량 모델' }).fill('합성 하이브리드');
  await page.getByRole('textbox', { name: '차량 색상' }).fill('은색');
  await page.getByRole('textbox', { name: '차량 식별 정보' }).fill('SYNTHETIC-E2E');
  await page.getByLabel('동승 가능 정원').selectOption('2');
  await page.getByRole('button', { name: '차량 정보 저장' }).click();
  await expect(page.getByText('차량 정보를 저장했습니다. 승인된 차량만 탑승 희망을 선택할 수 있습니다.')).toBeVisible();
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

test('a passenger can post and cancel a ride request', async ({ page }) => {
  await page.goto('/onboarding');
  await page.getByRole('button', { name: '가상 탑승자' }).click();
  const terms = page.getByRole('checkbox', { name: /서비스 이용 약관/ });
  const privacy = page.getByRole('checkbox', { name: /개인정보 처리방침 확인/ });
  if (!await terms.isChecked()) await terms.check();
  if (!await privacy.isChecked()) await privacy.check();
  await page.getByRole('button', { name: '탑승자 페이지' }).click();
  await page.getByRole('combobox', { name: '대기할 승차 지점·목적지' }).selectOption({ label: 'AI공학관 → 가상 캠퍼스' });
  const departure = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(Date.now() + 5 * 60_000)).replace(' ', 'T');
  await page.getByLabel('희망 출발 시각 (한국 시간)', { exact: true }).fill(departure);
  await page.getByRole('button', { name: '탑승 희망 등록' }).click();
  await expect(page.getByRole('heading', { name: '운전자 선택 대기' })).toBeVisible();
  await page.getByRole('button', { name: '탑승 희망 취소' }).click();
  await expect(page.getByText('탑승 희망 등록을 취소했습니다.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '탑승 희망 등록' })).toBeVisible();
});

test('driver and rider complete the fixed pickup workflow without GPS sharing', async ({ page, browser, request }) => {
  test.setTimeout(150_000);
  const riderContext = await browser.newContext({ baseURL: 'http://localhost:8787', timezoneId: 'Asia/Seoul' });
  const riderPage = await riderContext.newPage();
  let tripCreated = false;
  let postingCreated = false;
  let requestCreated = false;

  const acceptRequiredConsents = async (target: import('@playwright/test').Page) => {
    for (const label of [/서비스 이용 약관/, /개인정보 처리방침 확인/]) {
      const checkbox = target.getByRole('checkbox', { name: label });
      if (!await checkbox.isChecked()) await checkbox.check();
    }
  };

  try {
    await loginDriverWithTrip(page);
    await page.getByRole('button', { name: '운전자 페이지' }).click();
    const activeTrip = page.getByRole('heading', { name: '내 운행' });
    await expect(activeTrip).toBeVisible();
    await page.getByRole('button', { name: '운행 취소' }).click();
    await expect(page.getByText('운행을 취소했습니다.')).toBeVisible();
    await expect(page.getByRole('heading', { name: '탑승 희망 선택' })).toBeVisible();

    await riderPage.goto('/onboarding');
    await riderPage.getByRole('button', { name: '가상 탑승자' }).click();
    await acceptRequiredConsents(riderPage);
    await riderPage.getByRole('button', { name: '탑승자 페이지' }).click();
    const riderRoute = riderPage.getByRole('combobox', { name: '대기할 승차 지점·목적지' });
    await expect(riderRoute).toBeVisible();
    await expect(riderRoute.locator('option')).toHaveCount(4);
    const pickupOptions = await riderRoute.locator('option').allTextContents();
    for (const stop of ['AI공학관', '중앙도서관', '반도체대학']) {
      expect(pickupOptions.some((label) => label.startsWith(stop + ' →'))).toBe(true);
    }
    expect(pickupOptions.filter((label) => label.includes(' → '))).toHaveLength(3);
    await riderRoute.selectOption({ label: 'AI공학관 → 가상 캠퍼스' });
    const departureAt = Math.ceil((Date.now() + 30_000) / 60_000) * 60_000;
    const desiredDeparture = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(departureAt)).replace(' ', 'T');
    await riderPage.getByLabel('희망 출발 시각 (한국 시간)', { exact: true }).fill(desiredDeparture);
    await riderPage.getByRole('button', { name: '탑승 희망 등록' }).click();
    postingCreated = true;
    await expect(riderPage.getByRole('heading', { name: '운전자 선택 대기' })).toBeVisible();
    await expect(riderPage.getByText(/실시간 위치를 수집하거나 서로의 좌표를 공유하지 않습니다/)).not.toBeVisible();

    const ridePosting = page.getByRole('listitem').filter({ hasText: 'AI공학관 → 가상 캠퍼스' });
    await expect(ridePosting).toBeVisible({ timeout: 20_000 });
    await ridePosting.getByRole('button', { name: '선택 및 수락' }).click();
    await expect(page.getByText('탑승 희망을 선택했습니다. 탑승이 확정됐습니다.')).toBeVisible();
    tripCreated = true;
    const tripId = (await page.locator('section[aria-labelledby="active-trip-title"] code').textContent())?.trim() ?? '';
    expect(tripId).toBeTruthy();
    const tripData = await page.evaluate(async (id) => await fetch('/api/v1/trips/' + id, { cache: 'no-store' }).then((response) => response.json()), tripId);
    const actualDepartureAt = (tripData as { data: { departureAt: number } }).data.departureAt;

    requestCreated = true;
    await expect(riderPage.getByRole('heading', { name: '내 탑승 요청' })).toBeVisible();
    await expect(riderPage.getByRole('heading', { name: '선택한 승차 지점에서 대기' })).toBeVisible();
    await expect(riderPage.getByText(/대기 장소: AI공학관/)).toBeVisible();
    await expect(riderPage.getByText(/실시간 위치를 수집하거나 서로의 좌표를 공유하지 않습니다/)).toBeVisible();
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
    if (postingCreated && !requestCreated) {
      const cancelPosting = riderPage.getByRole('button', { name: '탑승 희망 취소' });
      if (await cancelPosting.isVisible().catch(() => false)) await cancelPosting.click().catch(() => undefined);
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
