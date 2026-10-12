import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'A little clarity. A lot of progress.' })).toBeVisible();
  await expect(page.getByText('You’re exploring demo mode.')).toBeVisible();
}

test('customer conversation, reviewed reply, handoff, and persistent job lifecycle', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Emma Wilson/ }).click();
  await expect(page.getByRole('heading', { name: 'Emma Wilson', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Simulate incoming customer message' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer message').fill('Can you repair a tap at 10 Oak Street tomorrow?');
  await dialog.getByRole('button', { name: 'Receive demo message' }).click();
  await expect(page.getByText('Can you repair a tap at 10 Oak Street tomorrow?', { exact: true }).last()).toBeVisible();
  await page.getByLabel('Reply to customer').fill('Thanks! Our team will confirm a time shortly.');
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  await expect(page.getByText('Thanks! Our team will confirm a time shortly.', { exact: true }).last()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByText('Thanks! Our team will confirm a time shortly.', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect(page.getByText('Human handoff · automation paused')).toBeVisible();
  await page.getByRole('button', { name: 'Resume reception', exact: true }).click();

  await page.getByRole('button', { name: 'New service job', exact: true }).click();
  const job = page.getByRole('dialog');
  await job.getByLabel('Job title', { exact: true }).fill('Browser test tap repair');
  await job.getByLabel('Customer name', { exact: true }).fill('Test Customer');
  await job.getByLabel(/^WhatsApp number/).fill('+27821234567');
  await job.getByLabel('Service address', { exact: true }).fill('10 Oak Street');
  await job.getByLabel('Notes', { exact: true }).fill('Confirm visit before attending.');
  await job.getByRole('button', { name: 'Create service job', exact: true }).click();
  await expect(job).not.toBeVisible();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByLabel('Search service jobs').fill('Browser test tap repair');
  await page.getByLabel('Status for Browser test tap repair').selectOption('completed');
  await expect(page.getByLabel('Status for Browser test tap repair')).toHaveValue('completed');
  await page.reload();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByLabel('Search service jobs').fill('Browser test tap repair');
  await expect(page.getByLabel('Status for Browser test tap repair')).toHaveValue('completed');
  await page.getByRole('button', { name: 'Activity log', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your workspace timeline' })).toBeVisible();
  await expect(page.getByText('New job added to the board.', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('reception preferences persist and templates require operator review', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Reception settings', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Handyman Test Studio');
  const toggle = page.getByRole('switch');
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('All settings are up to date')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Reception settings', exact: true }).click();
  await expect(page.getByLabel('Business name', { exact: true })).toHaveValue('Handyman Test Studio');
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Draft a reply', exact: true }).click();
  await expect(page.getByLabel('Reply to customer')).not.toHaveValue('');
  await expect(page.getByRole('button', { name: 'Simulate reply', exact: true })).toBeEnabled();
});

test('mobile navigation, keyboard form input, and sign-out work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByRole('button', { name: 'New service job', exact: true }).click();
  const title = page.getByRole('dialog').getByLabel('Job title', { exact: true });
  await title.pressSequentially('Keyboard typing must keep focus');
  await expect(title).toHaveValue('Keyboard typing must keep focus');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('slow replies cannot switch recipients or duplicate an Enter-key send', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Emma Wilson/ }).click();
  await expect(page.getByRole('heading', { name: 'Emma Wilson', exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/conversations/demo-conv-1/messages', async route => {
    requests++;
    await gate;
    await route.continue();
  });
  await page.getByLabel('Reply to customer').fill('A delayed reply for Emma only');
  await page.getByLabel('Reply to customer').press('Enter');
  await page.getByLabel('Reply to customer').press('Enter');
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: /James Mokoena/ }).click();
  await expect(page.getByRole('heading', { name: 'James Mokoena', exact: true })).toBeVisible();
  await page.getByLabel('Reply to customer').fill('Private draft for James');
  release();
  await expect(page.getByRole('status')).toContainText('Reply simulated');
  await expect(page.getByRole('heading', { name: 'James Mokoena', exact: true })).toBeVisible();
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Private draft for James');
  await expect(page.locator('.messages-area').getByText('A delayed reply for Emma only', { exact: true })).not.toBeVisible();
  const next = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/conversations/demo-conv-2/messages'));
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  expect((await next).postDataJSON().text).toBe('Private draft for James');
  await expect(page.getByText('Private draft for James', { exact: true }).last()).toBeVisible();
  expect(requests).toBe(1);
});

test('login and operator workflows meet tested WCAG AA accessibility checks', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const scan = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
  };
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the demo workspace' }).waitFor();
  await scan();
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await page.getByText('Conversations in motion', { exact: true }).waitFor();
  await scan();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Emma Wilson/ }).click();
  await page.getByRole('heading', { name: 'Emma Wilson', exact: true }).waitFor();
  await scan();
  await page.getByRole('button', { name: 'Reception settings', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).waitFor();
  await scan();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByLabel('Status for Fix leaking kitchen tap').waitFor();
  await scan();
  await page.getByRole('button', { name: 'New service job', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await scan();
});

test('job intake carries the selected customer into a scheduled request', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Olivia Jacobs/ }).click();
  await expect(page.getByRole('heading', { name: 'Olivia Jacobs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create job for customer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Customer name', { exact: true })).toHaveValue('Olivia Jacobs');
  await expect(dialog.getByLabel(/^WhatsApp number/)).toHaveValue('+27820000103');
  await dialog.getByLabel('Job title', { exact: true }).fill('Painting estimate from customer chat');
  await dialog.getByLabel(/^Scheduled date/).fill('2027-01-15T10:00');
  await dialog.getByRole('button', { name: 'Create service job', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByLabel('Search service jobs').fill('Painting estimate from customer chat');
  const row = page.getByRole('row').filter({ hasText: 'Painting estimate from customer chat' });
  await expect(row).toContainText('Olivia Jacobs');
  await expect(row).toContainText('15 Jan 2027');
});

test('AI context sharing requires disclosure and explicit generation', async ({ page }) => {
  let drafts = 0;
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, integration: { ...data.integration, aiConfigured: true } } });
  });
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/draft')) drafts++; });
  await login(page);
  await page.request.patch('/api/settings', { headers: { Origin: 'http://127.0.0.1:4179' }, data: { automationEnabled: true } });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Generate AI draft', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('shares this customer’s conversation');
  expect(drafts).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(drafts).toBe(0);
  await page.getByRole('button', { name: 'Generate AI draft', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generate draft', exact: true }).click();
  await expect(page.getByLabel('Reply to customer')).not.toHaveValue('');
  expect(drafts).toBe(1);
});
