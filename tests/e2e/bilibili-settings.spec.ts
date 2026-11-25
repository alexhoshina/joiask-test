import { randomUUID } from 'node:crypto';
import { apiData, expect, test } from './fixtures.js';

test('超级管理员可以先测试 B 站资料接口，再保存候选地址', async ({ adminPage, adminApi }) => {
  const getURL = async () => (await apiData<{ bilibili_profile_url: string }>(adminApi.get('/api/settings'))).bilibili_profile_url;
  const original = await getURL();
  const candidate = 'https://bili.example.com/card';
  const uid = '9007199254740993';
  const requests: { method: string; data: unknown }[] = [];
  await adminPage.route('**/api/settings/bilibili/test', async route => {
    requests.push({ method: route.request().method(), data: route.request().postDataJSON() });
    const json = requests.length === 1
      ? { code: 502, message: '资料服务暂时不可用' }
      : { code: 200, data: { uid, name: '资料接口测试用户', signature: '测试签名' } };
    await route.fulfill({ json });
  });
  try {
    await adminPage.goto('/admin/dashboard/settings/');
    const address = adminPage.getByLabel('B 站用户资料接口地址');
    const testButton = adminPage.getByRole('button', { name: '测试连接' });
    await expect(address).toHaveValue(original);
    await address.fill(candidate);
    await adminPage.getByLabel('测试用 B 站 UID').fill(uid);
    await testButton.click();
    const profileForm = adminPage.locator('form').filter({ has: address });
    await expect(profileForm.getByRole('alert')).toHaveText('资料服务暂时不可用');
    await testButton.click();
    const preview = adminPage.getByRole('status').filter({ hasText: '资料接口测试用户' });
    await expect(preview).toContainText(uid);
    await expect(preview).toContainText('测试签名');
    const expected = { method: 'POST', data: { bilibili_profile_url: candidate, bilibili_uid: uid } };
    expect(requests).toEqual([expected, expected]);
    expect(await getURL()).toBe(original);

    await adminPage.getByRole('button', { name: '保存设置' }).click();
    await expect(adminPage.getByText('保存成功', { exact: true })).toBeVisible();
    await adminPage.reload();
    await expect(address).toHaveValue(candidate);
    expect(await getURL()).toBe(candidate);
  } finally {
    await apiData(adminApi.put('/api/settings', { data: { bilibili_profile_url: original } }));
  }
});

test('普通管理员可以保存现有设置，不能更改或试读 B 站资料接口', async ({ adminApi, page }) => {
  const credentials = { username: 'editor-' + randomUUID().slice(0, 8), password: 'only-for-local-e2e' };
  const account = await apiData<{ id: number }>(adminApi.post('/api/user', { data: { ...credentials, role: 'admin' } }));
  try {
    await apiData(page.request.post('/api/login', { data: credentials }));
    await page.goto('/admin/dashboard/settings/');
    const save = page.getByRole('button', { name: '保存设置' });
    await expect(save).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: '自动公开 AI 判定为正常的提问' })).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: '当前模型支持图片输入' })).toBeEnabled();
    await expect(page.getByLabel('B 站用户资料接口地址')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '测试连接' })).toHaveCount(0);
    const savedRequest = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings');
    await save.click();
    expect((await savedRequest).postDataJSON()).not.toHaveProperty('bilibili_profile_url');
    await expect(page.getByText('保存成功', { exact: true })).toBeVisible();

    const candidate = { bilibili_profile_url: 'https://bili.example.com/card' };
    const changed = await page.request.put('/api/settings', { data: candidate });
    expect(await changed.json()).toMatchObject({ code: 403 });
    const tested = await page.request.post('/api/settings/bilibili/test', { data: { ...candidate, bilibili_uid: '123' } });
    expect(await tested.json()).toMatchObject({ code: 403 });
  } finally {
    await apiData(adminApi.delete('/api/user/' + account.id));
  }
});
