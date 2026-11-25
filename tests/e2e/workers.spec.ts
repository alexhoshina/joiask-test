import { apiData, expect, test } from './fixtures.js';

test('注册挑战在刷新后可恢复，只有原会话能读取验证码', async ({ page, request }) => {
  const uid = '9007199254740993';
  const openRegistration = async () => {
    await page.goto('/');
    await page.getByRole('button', { name: '登录 / 注册' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '注册', exact: true }).click();
  };
  await openRegistration();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[inputmode="numeric"]').fill(uid);
  await dialog.getByRole('button', { name: '开始验证' }).click();
  const code = dialog.locator('code');
  await expect(code).toBeVisible();
  const challenge = await code.innerText();
  expect(challenge.length).toBeGreaterThan(8);
  await expect(dialog.getByRole('link', { name: new RegExp(uid) })).toHaveAttribute('href', 'https://space.bilibili.com/' + uid);
  await expect(dialog.getByRole('button', { name: '我已修改签名，立即验证' })).toBeEnabled();
  expect((await (await request.get('/api/account/verification')).json()).code).toBe(404);
  await openRegistration();
  await expect(code).toHaveText(challenge);
});

test('彩虹屁页注册可更换 UID、恢复新验证码并取消验证', async ({ page, request }) => {
  const prefix = String(Date.now());
  const [originalUid, newUid, occupiedUid] = ['1', '2', '3'].map(suffix => prefix + suffix);
  const endpoint = '/api/account/verification';
  const dialog = page.getByRole('dialog');
  const code = dialog.locator('code');
  const openRegister = async () => {
    await page.getByRole('button', { name: '登录 / 注册', exact: true }).click();
    await dialog.getByRole('button', { name: '注册', exact: true }).click();
  };
  const expectSpace = async (uid: string) => {
    await expect(dialog.getByRole('link', { name: '打开 UID ' + uid + ' 的空间', exact: true }))
      .toHaveAttribute('href', 'https://space.bilibili.com/' + uid);
  };

  // Reserve a third UID in another cookie jar to exercise a real replacement conflict.
  await apiData(request.post(endpoint, { data: { bilibili_uid: occupiedUid } }));
  await page.goto('/rainbow/');
  await openRegister();
  const initialInput = dialog.getByLabel('你的 B 站 UID', { exact: true });
  const change = dialog.getByRole('button', { name: '更换 UID', exact: true });
  const replacement = dialog.getByLabel('新的 B 站 UID', { exact: true });
  await initialInput.fill(originalUid);
  await dialog.getByRole('button', { name: '开始验证' }).click();
  await expectSpace(originalUid);
  await expect(code).toHaveText(/\S+/);
  const originalCode = await code.innerText();

  await change.click();
  await expect(replacement).toHaveValue(originalUid);
  await replacement.fill(occupiedUid);
  await dialog.getByRole('button', { name: '验证新 UID' }).click();
  await expect(dialog.getByRole('alert')).toContainText('正在验证');
  await expect(replacement).toHaveValue(occupiedUid);
  await dialog.getByRole('button', { name: '返回原验证' }).click();
  await expectSpace(originalUid);
  await expect(code).toHaveText(originalCode);

  await change.click();
  await replacement.fill(newUid);
  await dialog.getByRole('button', { name: '验证新 UID' }).click();
  await expectSpace(newUid);
  await expect(code).toHaveText(/\S+/);
  const newCode = await code.innerText();
  expect(newCode).not.toBe(originalCode);
  // The original UID must be available immediately, while the browser still holds the new one.
  await apiData(request.delete(endpoint));
  const reclaimed = await apiData<{ challenge_code: string }>(request.post(endpoint, { data: { bilibili_uid: originalUid } }));
  expect(reclaimed.challenge_code).not.toBe(originalCode);

  await page.reload();
  await openRegister();
  await expectSpace(newUid);
  await expect(code).toHaveText(newCode);
  await dialog.getByRole('button', { name: '取消验证' }).click();
  await expect(initialInput).toHaveValue('');
  await page.reload();
  await openRegister();
  await expect(initialInput).toHaveValue('');
  await expect(code).toHaveCount(0);
  expect((await (await page.request.get(endpoint)).json()).code).toBe(404);
  await initialInput.fill(newUid);
  await dialog.getByRole('button', { name: '开始验证' }).click();
  await expectSpace(newUid);
  await expect(code).toHaveText(/\S+/);
  await expect(code).not.toHaveText(newCode);
});

test('动态站点配置进入首屏 HTML，后台和文档深链由同一站点提供', async ({ request, adminApi }) => {
  const original = await apiData<{site_name:string;custom_css:string;favicon_url:string}>(adminApi.get('/api/config'));
  try {
    const icon = '/upload-img/site-test-icon.png';
    await apiData(adminApi.put('/api/config', { data: { site_name: 'Workers SSR 测试', custom_css: ':root{--e2e-ssr:1}', favicon_url: icon } }));
    const html = await (await request.get('/')).text();
    expect(html).toContain('<title>Workers SSR 测试</title>');
    expect(html).toContain('--e2e-ssr:1');
    expect(html.match(/<link\b[^>]*>/g)).toEqual(expect.arrayContaining([
      expect.stringMatching(/(?=.*\brel="icon")(?=.*\bhref="\/upload-img\/site-test-icon\.png")/),
    ]));
    expect((await request.get('/admin/dashboard/questions/')).ok()).toBeTruthy();
    expect((await request.get('/docs/')).ok()).toBeTruthy();
  } finally {
    await apiData(adminApi.put('/api/config', { data: { site_name: original.site_name, custom_css: original.custom_css, favicon_url: original.favicon_url } }));
  }
});

test('管理后台从本站加载 CSS 编辑器', async ({ adminPage }) => {
  const [loader] = await Promise.all([
    adminPage.waitForResponse('/admin/monaco/vs/loader.js'),
    adminPage.goto('/admin/dashboard/custom/'),
  ]);
  expect(loader.ok()).toBeTruthy();
  await expect(adminPage.locator('.monaco-editor')).toBeVisible();
});

test('设置读写隐藏 SMTP 密码和模型密钥，普通访客只能读取公开配置', async ({ request, adminApi }) => {
  const original = await apiData<Record<string, unknown>>(adminApi.get('/api/settings'));
  try {
    const email = { ...(original.email as object), enabled: false, host: 'smtp.example.org', password: 'fixture-smtp-value' };
    await apiData(adminApi.put('/api/settings', { data: { ...original, email, ai_api_key: 'fixture-model-value' } }));
    const settings = await apiData<{email:{password_configured:boolean}; ai_api_key_configured:boolean}>(adminApi.get('/api/settings'));
    expect(settings.ai_api_key_configured).toBe(true);
    expect(settings.email.password_configured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('fixture-');
    expect(await (await request.get('/api/settings')).json()).toMatchObject({ code: 408 });
    const site = await apiData<Record<string, unknown>>(request.get('/api/config'));
    expect(site).not.toHaveProperty('ai_api_key');
    expect(site).not.toHaveProperty('smtp_password');
  } finally {
    await apiData(adminApi.put('/api/settings', { data: { ...original, ai_api_key: null, email: { ...(original.email as object), password: null } } }));
  }
});
