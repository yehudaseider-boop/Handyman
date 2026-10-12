import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

const origin = 'http://127.0.0.1:4179';
const mutationHeaders = { Origin: origin };

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'A little clarity. A lot of progress.' })).toBeVisible();
}

test('reviewed customer intake becomes one draft, then a conflict-checked weekly appointment', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Aisha Patel/ }).click();
  await page.getByRole('button', { name: 'Simulate incoming customer message' }).click();
  const inbound = page.getByRole('dialog');
  await inbound.getByLabel('Customer message').fill('The bathroom tap is leaking. I am at 55 Cedar Road. Tomorrow morning please.');
  await inbound.getByRole('button', { name: 'Receive demo message' }).click();
  await expect(inbound).not.toBeVisible();
  await page.getByRole('button', { name: 'Analyze request', exact: true }).click();
  await expect(page.getByLabel('Request address', { exact: true })).toHaveValue('55 Cedar Road');
  await expect(page.getByLabel(/^Customer’s preferred time/)).toHaveValue('Tomorrow morning');
  await page.getByText(/^Original customer quotes/).click();
  await expect(page.locator('.intake-evidence')).toContainText('55 Cedar Road');
  await page.getByRole('textbox', { name: 'Request summary', exact: true }).fill('Browser-reviewed tap repair');
  await expect(page.getByRole('button', { name: 'Create draft job', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save reviewed details', exact: true }).click();
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const intakeScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(intakeScan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.getByRole('button', { name: 'Create draft job', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View linked job', exact: true })).toBeVisible();
  const intake = (await (await page.request.get('/api/conversations/demo-conv-5/intake')).json()).intake;
  const retry = await page.request.post('/api/conversations/demo-conv-5/intake/job', { headers: mutationHeaders, data: { expectedVersion: 1 } });
  expect(retry.status()).toBe(200);
  expect((await retry.json()).job.id).toBe(intake.jobId);
  const draft = (await (await page.request.get(`/api/jobs/${intake.jobId}`)).json()).job;
  expect(draft.scheduledAt).toBe('');
  expect(draft.status).toBe('new');

  // Pick a local afternoon in the displayed current week; no customer promise is inferred from "tomorrow".
  const visit = await page.evaluate(() => {
    const date = new Date();
    date.setHours(15, 0, 0, 0);
    const pad = (value: number) => String(value).padStart(2, '0');
    return { iso: date.toISOString(), local: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T15:00` };
  });
  const blocker = await page.request.post('/api/jobs', { headers: mutationHeaders, data: { title: 'Existing team appointment', customerName: 'Schedule test', phone: '+27821234560', assignedTo: 'Browser team', scheduledAt: visit.iso, status: 'scheduled', durationMinutes: 90 } });
  expect(blocker.status()).toBe(201);
  await page.getByRole('button', { name: 'View linked job', exact: true }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: 'Edit service job', exact: true })).toBeVisible();
  await expect(editor.getByLabel('Customer name', { exact: true })).toHaveValue('Aisha Patel');
  await editor.getByLabel('Assigned team', { exact: true }).fill('Browser team');
  await editor.getByLabel('Visit duration (minutes)', { exact: true }).fill('45');
  await editor.getByLabel(/^Scheduled date & time/).fill(visit.local);
  await editor.getByRole('button', { name: 'Save job details', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('already has a job');
  await expect(editor.getByLabel('Job title', { exact: true })).toHaveValue('Browser-reviewed tap repair');
  await editor.getByLabel('Assigned team', { exact: true }).fill('Second browser team');
  await editor.getByRole('button', { name: 'Save job details', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit scheduled job Browser-reviewed tap repair', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit scheduled job Browser-reviewed tap repair', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Edit scheduled job Browser-reviewed tap repair', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Visit duration (minutes)', { exact: true })).toHaveValue('45');
  await page.keyboard.press('Escape');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Edit scheduled job Browser-reviewed tap repair', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AI intake disclosure cannot bypass unsaved customer review', async ({ page }) => {
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, integration: { ...data.integration, aiConfigured: true } } });
  });
  let shared = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/intake/analyze') && req.postDataJSON()?.useAi) shared++; });
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Olivia Jacobs/ }).click();
  await page.getByRole('button', { name: 'Analyze request', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Request summary', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Analyze with AI', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI analysis consent' })).toContainText('OpenAI');
  expect(shared).toBe(0);
  await page.getByLabel('Request address', { exact: true }).fill('Operator is reviewing this address');
  const share = page.getByRole('button', { name: 'Share conversation and analyze', exact: true });
  if (await share.isVisible()) await expect(share).toBeDisabled();
  expect(shared).toBe(0);
  await expect(page.getByLabel('Request address', { exact: true })).toHaveValue('Operator is reviewing this address');
  await expect(page.getByRole('button', { name: 'Analyze with AI', exact: true })).toBeDisabled();
});

test('a delayed reply or suggestion preserves newer text for the same customer', async ({ page }) => {
  await login(page);
  await page.request.patch('/api/settings', { headers: mutationHeaders, data: { automationEnabled: true } });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Emma Wilson/ }).click();
  let releaseSend!: () => void;
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
  await page.route('**/api/conversations/demo-conv-1/messages', async route => { await sendGate; await route.continue(); });
  const sending = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/demo-conv-1/messages'));
  await page.getByLabel('Reply to customer').fill('First reply, then keep the next thought');
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  await sending;
  await page.getByLabel('Reply to customer').fill('Newer unsent follow-up');
  releaseSend();
  await expect(page.locator('.messages-area').getByText('First reply, then keep the next thought', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Newer unsent follow-up');
  await expect(page.getByRole('button', { name: 'Draft a reply', exact: true })).toBeEnabled();
  let releaseDraft!: () => void;
  const draftGate = new Promise<void>(resolve => { releaseDraft = resolve; });
  await page.route('**/api/conversations/demo-conv-1/draft', async route => { await draftGate; await route.continue(); });
  const drafting = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/demo-conv-1/draft'));
  await page.getByRole('button', { name: 'Draft a reply', exact: true }).click();
  await drafting;
  await page.getByLabel('Reply to customer').fill('Operator text while a suggestion is pending');
  releaseDraft();
  await expect(page.getByRole('status')).toContainText('Your text was kept');
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Operator text while a suggestion is pending');
});

test('dismissing a pending job save cannot close a newer job dialog', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New service job', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Job title', { exact: true }).fill('Job saved after its dialog was dismissed');
  await editor.getByLabel('Customer name', { exact: true }).fill('Pending save customer');
  await editor.getByLabel(/^WhatsApp number/).fill('+27821234561');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/jobs', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  const pending = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/jobs'));
  await editor.getByRole('button', { name: 'Create service job', exact: true }).click();
  await pending;
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
  await page.getByRole('button', { name: 'New service job', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Job title', { exact: true }).fill('Newer operator work must stay open');
  const completed = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/api/jobs'));
  release();
  expect((await completed).status()).toBe(201);
  await expect(page.getByRole('dialog').getByLabel('Job title', { exact: true })).toHaveValue('Newer operator work must stay open');
});

test('urgent handoff and the reply composer remain usable on desktop and mobile', async ({ page }) => {
  await login(page);
  await page.request.post('/api/demo/inbound', { headers: mutationHeaders, data: { conversationId: 'demo-conv-4', text: 'The outlet is sparking. Please let me speak with a human. 42 Park Avenue tomorrow morning.' } });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Daniel Smith/ }).click();
  await page.getByRole('button', { name: 'Analyze request', exact: true }).click();
  await expect(page.getByText('Human handoff · automation paused')).toBeVisible();
  await expect(page.locator('.intake-state')).toContainText('Needs human attention');
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const bounds = await page.evaluate(() => {
      const panel = document.querySelector('.inbox-workspace')!.getBoundingClientRect();
      const composer = document.querySelector('.composer-wrap')!.getBoundingClientRect();
      const heading = document.querySelector('.conversation-heading')!.getBoundingClientRect();
      return { panelTop: panel.top, panelBottom: panel.bottom, composerTop: composer.top, composerBottom: composer.bottom, headingTop: heading.top, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(bounds.composerBottom).toBeLessThanOrEqual(bounds.panelBottom + 1);
    expect(bounds.composerTop).toBeGreaterThan(bounds.panelTop);
    expect(bounds.headingTop).toBeGreaterThanOrEqual(bounds.panelTop);
    expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  }
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
});
