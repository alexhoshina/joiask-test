import { apiData, test, expect } from './fixtures.js';

test('图片审核关闭时也能保存视觉测试超时，并校验整数范围', async ({ adminApi, adminPage }) => {
  const getSettings = () => apiData<{ ai_vision_test_timeout_seconds: number; ai_supports_vision: boolean }>(adminApi.get('/api/settings'));
  const original = await getSettings();
  expect(original.ai_vision_test_timeout_seconds).toBe(20);
  expect(original.ai_supports_vision).toBe(false);
  try {
    await adminPage.goto('/admin/dashboard/settings/');
    const input = adminPage.getByRole('spinbutton', { name: '视觉测试超时（秒）' });
    const save = adminPage.getByRole('button', { name: '保存设置' });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('20');
    for (const invalid of ['0', '301', '1.5', '']) {
      await input.fill(invalid);
      await save.click();
      await expect(adminPage.getByText('视觉测试超时必须是 1 至 300 之间的整数')).toBeVisible();
      expect((await getSettings()).ai_vision_test_timeout_seconds).toBe(20);
    }
    for (const seconds of [1, 300]) {
      await input.fill(String(seconds));
      await save.click();
      await expect(adminPage.getByText('保存成功', { exact: true })).toBeVisible();
      expect(await getSettings()).toMatchObject({ ai_vision_test_timeout_seconds: seconds, ai_supports_vision: false });
      await adminPage.reload();
      await expect(input).toHaveValue(String(seconds));
    }
  } finally {
    await apiData(adminApi.put('/api/settings', { data: { ai_vision_test_timeout_seconds: original.ai_vision_test_timeout_seconds } }));
  }
});

test('模型图片输入需要重新确认，缺少 API Key 时保留原设置', async ({ adminApi, adminPage }) => {
  type Settings = { ai_model: string; ai_base_url: string; ai_supports_vision: boolean; ai_api_key_configured: boolean };
  const getSettings = () => apiData<Settings>(adminApi.get('/api/settings'));
  const { ai_model, ai_base_url, ai_supports_vision, ai_api_key_configured } = await getSettings();
  expect(ai_supports_vision).toBe(false);
  expect(ai_api_key_configured).toBe(false);
  try {
    await adminPage.goto('/admin/dashboard/settings/');
    const vision = adminPage.getByRole('checkbox', { name: '当前模型支持图片输入' });
    await expect(vision).toBeEnabled();
    await expect(vision).not.toBeChecked();
    await vision.check();
    await adminPage.getByLabel('模型名称').fill('e2e-vision-model');
    await expect(vision).not.toBeChecked();
    await vision.check();
    await adminPage.getByLabel('API 基础地址').fill('https://models.example.com/v1');
    await expect(vision).not.toBeChecked();
    await vision.check();
    await adminPage.getByRole('button', { name: '保存设置' }).click();
    await expect(adminPage.getByText(/请先填写 AI 服务 API Key/)).toBeVisible();
    expect(await getSettings()).toMatchObject({ ai_model, ai_base_url, ai_supports_vision: false });
    await adminPage.reload();
    await expect(vision).toBeEnabled();
    await expect(vision).not.toBeChecked();
  } finally {
    await apiData(adminApi.put('/api/settings', { data: { ai_model, ai_base_url, ai_supports_vision } }));
  }
});

test('审核自动公开默认关闭，开启和关闭后刷新均保留设置', async ({ adminPage, adminApi }) => {
  const settings = () => apiData<{ ai_auto_publish: boolean }>(adminApi.get('/api/settings'));
  const original = await settings();
  expect(original.ai_auto_publish).toBe(false);
  try {
    await adminPage.goto('/admin/dashboard/settings/');
    const toggle = adminPage.getByRole('checkbox', { name: '自动公开 AI 判定为正常的提问' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    for (const enabled of [true, false]) {
      await toggle.setChecked(enabled);
      await adminPage.getByRole('button', { name: '保存设置' }).click();
      await expect(adminPage.getByText('保存成功', { exact: true })).toBeVisible();
      expect((await settings()).ai_auto_publish).toBe(enabled);
      await adminPage.reload();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked({ checked: enabled });
    }
  } finally {
    await apiData(adminApi.put('/api/settings', { data: { ai_auto_publish: original.ai_auto_publish } }));
  }
});

test('匿名投稿经后台审核公开后可见，撤回公开后不可见', async ({ page, adminPage, dataset }) => {
  const content = `待审核提问 ${dataset.tag.tag_name}`;
  await page.goto('/');
  await page.getByRole('combobox').filter({ hasText: '选择话题' }).click();
  await page.getByRole('option', { name: `#${dataset.tag.tag_name}`, exact: true }).click();
  await page.getByPlaceholder('输入你的提问...').fill(content);
  await page.getByRole('checkbox', { name: '彩虹屁', exact: true }).check();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByText('提问已提交审核，内容将会在审核通过后放出')).toBeVisible();
  await expect(page.getByPlaceholder('输入你的提问...')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ask_content'))).toBe('');
  const questions = await dataset.questions();
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({ content, is_publish: false, is_rainbow: true });

  await page.goto('/search/');
  await page.getByPlaceholder('输入搜索内容...').fill(content);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('没有找到相关的提问')).toBeVisible();

  await adminPage.goto('/admin/dashboard/questions/');
  const row = adminPage.getByRole('row').filter({ hasText: content });
  await expect(row).toBeVisible();
  await expect(row.getByRole('checkbox', { name: '公开', exact: true })).not.toBeChecked();
  // This controlled checkbox updates only after its API request completes.
  await row.getByRole('checkbox', { name: '公开', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: '公开', exact: true })).toBeChecked();
  await expect.poll(async () => (await dataset.questions())[0].is_publish).toBe(true);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText(content, { exact: true })).toBeVisible();

  // Reload verifies the change was saved, rather than only toggling local state.
  await adminPage.reload();
  await expect(row.getByRole('checkbox', { name: '公开', exact: true })).toBeChecked();
  await expect(row.getByRole('checkbox', { name: '彩虹屁', exact: true })).toBeChecked();
  await row.getByRole('checkbox', { name: '公开', exact: true }).click();
  await expect(row.getByRole('checkbox', { name: '公开', exact: true })).not.toBeChecked();
  await expect.poll(async () => (await dataset.questions())[0].is_publish).toBe(false);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('没有找到相关的提问')).toBeVisible();
  await expect(page.getByText(content, { exact: true })).toHaveCount(0);
});

test('提问可以移入拦截箱、恢复和删除', async ({ adminPage, dataset }) => {
  const content = `拦截箱测试 ${dataset.tag.tag_name}`;
  await dataset.createQuestion(content);
  await adminPage.goto('/admin/dashboard/questions/');
  const row = adminPage.getByRole('row').filter({ hasText: content });
  await row.getByRole('button', { name: '打开操作菜单' }).click();
  await adminPage.getByRole('menuitem', { name: '移到拦截箱' }).click();
  await expect(row).toHaveCount(0);
  await adminPage.getByRole('link', { name: '拦截箱', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '打开操作菜单' }).click();
  await adminPage.getByRole('menuitem', { name: '移入收件箱' }).click();
  await expect(row).toHaveCount(0);
  await adminPage.getByRole('link', { name: '收件箱', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '打开操作菜单' }).click();
  await adminPage.getByRole('menuitem', { name: '删除' }).click();
  const dialog = adminPage.getByRole('dialog');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect.poll(() => dataset.questions()).toEqual([]);
});
