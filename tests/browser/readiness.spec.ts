import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

const origin = 'http://127.0.0.1:4179';
const headers = { Origin: origin };
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'A little clarity. A lot of progress.' })).toBeVisible();
}
async function select(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('customer drafts survive conversation and page changes but clear on sign-out', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'Emma Wilson');
  await page.getByLabel('Reply to customer').fill('Private unfinished reply for Emma');
  await select(page, 'James Mokoena');
  await page.getByLabel('Reply to customer').fill('Separate unfinished reply for James');
  await select(page, 'Emma Wilson');
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Private unfinished reply for Emma');
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Private unfinished reply for Emma');
  await select(page, 'James Mokoena');
  await expect(page.getByLabel('Reply to customer')).toHaveValue('Separate unfinished reply for James');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'James Mokoena');
  await expect(page.getByLabel('Reply to customer')).toHaveValue('');
});

test('an accepted reply with a lost browser response remains idempotent after navigation', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'Emma Wilson');
  const intents: string[] = [];
  await page.route('**/api/conversations/demo-conv-1/messages', async route => {
    intents.push(route.request().postDataJSON().idempotencyKey);
    if (intents.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  const reply = 'Browser response lost: preserve the same send identifier';
  await page.getByLabel('Reply to customer').fill(reply);
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not reach the server');
  await expect(page.getByRole('button', { name: 'Simulate reply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('Reply to customer')).toHaveValue(reply);
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  await expect(page.getByLabel('Reply to customer')).toHaveValue('');
  expect(intents).toHaveLength(2);
  expect(intents[1]).toBe(intents[0]);
  const result = await page.request.get('/api/conversations/demo-conv-1?limit=100');
  const data = await result.json();
  expect(data.messages.filter((message: { text: string }) => message.text === reply)).toHaveLength(1);
});

test('a delayed conversation refresh cannot undo human takeover', async ({ page }) => {
  await login(page);
  await page.request.patch('/api/conversations/demo-conv-1', { headers, data: { automationPaused: false, status: 'open' } });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'Emma Wilson');
  await expect(page.getByRole('button', { name: 'Take over', exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const snapshotReady = new Promise<void>(resolve => { captured = resolve; });
  let completed!: () => void;
  const routeDone = new Promise<void>(resolve => { completed = resolve; });
  await page.route(/\/api\/conversations\/demo-conv-1(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const old = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response: old }).catch(() => {});
    completed();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await snapshotReady;
  await page.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect(page.getByText('Human handoff · automation paused')).toBeVisible();
  release();
  await routeDone;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Human handoff · automation paused')).toBeVisible();
  await page.unroute(/\/api\/conversations\/demo-conv-1(?:\?.*)?$/);
  await page.getByRole('button', { name: 'Resume reception', exact: true }).click();
});

test('long conversation history loads in pages and preserves the reading position', async ({ page }) => {
  await login(page);
  for (let index = 0; index < 65; index++) {
    const response = await page.request.post('/api/demo/inbound', { headers, data: { conversationId: 'demo-conv-2', text: `Readiness history line ${String(index).padStart(3, '0')} — customer details for review.` } });
    expect(response.status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'James Mokoena');
  await expect(page.locator('.message-row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).not.toBeVisible();
  const count = await page.locator('.message-row').count();
  expect(count).toBeGreaterThanOrEqual(68);
  await page.locator('.messages-area').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  const position = await page.locator('.messages-area').evaluate(element => element.scrollTop);
  await page.request.post('/api/demo/inbound', { headers, data: { conversationId: 'demo-conv-2', text: 'A new message while the operator reads earlier history.' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'New messages · jump to latest', exact: true })).toBeVisible();
  expect(await page.locator('.messages-area').evaluate(element => element.scrollTop)).toBe(position);
  await expect(page.locator('.message-row')).toHaveCount(count + 1);
  await page.getByRole('button', { name: 'New messages · jump to latest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New messages · jump to latest', exact: true })).not.toBeVisible();
  await expect(page.locator('.messages-area').getByText('A new message while the operator reads earlier history.', { exact: true })).toBeInViewport();
});

test('unsaved intake review survives navigation and refuses to overwrite a newer record', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'Olivia Jacobs');
  const current = (await (await page.request.get('/api/conversations/demo-conv-3/intake')).json()).intake;
  if (!current) await page.getByRole('button', { name: 'Analyze request', exact: true }).click();
  await expect(page.getByLabel('Request address', { exact: true })).toBeVisible();
  await page.getByLabel('Request address', { exact: true }).fill('Unsaved address under operator review');
  await page.getByRole('button', { name: 'Service jobs', exact: true }).click();
  const before = (await (await page.request.get('/api/conversations/demo-conv-3/intake')).json()).intake;
  const changed = await page.request.patch('/api/conversations/demo-conv-3/intake', { headers, data: { expectedVersion: before.version, address: 'Another operator confirmed 27 Willow Road' } });
  expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('Request address', { exact: true })).toHaveValue('Unsaved address under operator review');
  await expect(page.getByRole('alert')).toContainText('Your unsaved review was kept');
  await page.getByRole('button', { name: 'Save reviewed details', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This record changed');
  const preserved = (await (await page.request.get('/api/conversations/demo-conv-3/intake')).json()).intake;
  expect(preserved.address).toBe('Another operator confirmed 27 Willow Road');
  await page.getByRole('button', { name: 'Reload latest request (discard edits)', exact: true }).click();
  await expect(page.getByLabel('Request address', { exact: true })).toHaveValue('Another operator confirmed 27 Willow Road');
});

test('launch checklist is truthful and unreadable server responses recover visibly', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Reception settings', exact: true }).click();
  const checklist = page.getByRole('region', { name: 'Launch checklist' });
  await expect(checklist).toContainText('A real message test is still required');
  await expect(checklist).toContainText('WhatsApp access token');
  await expect(checklist).toContainText('Required');
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.route('**/api/conversations', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Upstream unavailable</html>' }));
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unreadable response');
});

test('refresh preserves provider arrival order when timestamps have different precision in the same second', async ({ page }) => {
  await login(page);
  const pattern = /\/api\/conversations\/demo-conv-1(?:\?.*)?$/;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, messages: [
      { ...data.messages[0], id: 'mixed-precision-outbound', direction: 'outbound', text: 'Sent first in the same second', createdAt: '2026-10-12T10:00:00.950Z', status: 'sent' },
      { ...data.messages[1], id: 'mixed-precision-inbound', direction: 'inbound', text: 'Received afterward in the same second', createdAt: '2026-10-12T10:00:00.000Z', status: 'received' },
    ] } });
  });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await select(page, 'Emma Wilson');
  const bubbles = page.locator('.messages-area .message-bubble p');
  await expect(bubbles).toHaveText(['Sent first in the same second', 'Received afterward in the same second']);
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && pattern.test(response.url()));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(bubbles).toHaveText(['Sent first in the same second', 'Received afterward in the same second']);
});
