import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

const headers = { Origin: 'http://127.0.0.1:4179' };
async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore the demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'A little clarity. A lot of progress.' })).toBeVisible();
}
async function approve(page: Page) {
  const {knowledge} = await (await page.request.get('/api/knowledge')).json();
  const {version,...fields}=knowledge;
  const response=await page.request.patch('/api/knowledge',{headers,data:{...fields,approved:true,expectedVersion:version}});
  expect(response.status()).toBe(200);
  const {policy}=await (await page.request.get('/api/automation')).json();
  expect((await page.request.patch('/api/automation',{headers,data:{businessHoursOnly:false,expectedVersion:policy.version}})).status()).toBe(200);
}

test('reviewed business facts drive a local sandbox response and saving edits revokes approval', async ({page}) => {
  await login(page);
  await page.getByRole('button',{name:'Business knowledge',exact:true}).click();
  await page.getByRole('textbox',{name:/Service areas/}).fill('Cape Town, Sandton');
  await page.getByRole('textbox',{name:'Service keywords',exact:true}).first().fill('tap, leak, sink');
  await expect(page.getByRole('textbox',{name:'Service keywords',exact:true}).first()).toHaveValue('tap, leak, sink');
  await page.getByRole('button',{name:'Add FAQ',exact:true}).click();
  await page.getByRole('textbox',{name:'Question',exact:true}).last().fill('How should I prepare?');
  await page.getByRole('textbox',{name:'Approved answer',exact:true}).last().fill('Please clear access to the repair area.');
  await page.getByRole('textbox',{name:'Question keywords',exact:true}).last().fill('prepare, preparation');
  await page.getByRole('checkbox',{name:'I reviewed these business facts',exact:true}).check();
  await page.getByRole('button',{name:'Save business knowledge',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('reviewed and saved');
  const saved=(await (await page.request.get('/api/knowledge')).json()).knowledge;
  expect(saved.approved).toBe(true);
  expect(saved.serviceAreas).toEqual(['Cape Town','Sandton']);
  expect(saved.services[0].keywords).toEqual(['tap','leak','sink']);
  const {policy}=await (await page.request.get('/api/automation')).json();
  await page.request.patch('/api/automation',{headers,data:{businessHoursOnly:false,expectedVersion:policy.version}});
  await page.getByRole('button',{name:'Reception lab',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Try it here. Learn before going live.',exact:true})).toBeInViewport();
  await page.getByRole('textbox',{name:'Test message',exact:true}).fill('How should I prepare?');
  await page.getByRole('button',{name:'Add turn',exact:true}).click();
  await page.getByRole('button',{name:'Preview reception decision',exact:true}).click();
  await expect(page.locator('.lab-decision')).toContainText('Please clear access to the repair area.');
  await expect(page.locator('.lab-decision')).toContainText('Routine reply');
  await page.getByRole('button',{name:'Run safety checks',exact:true}).click();
  await expect(page.getByText(/scenarios passed/)).toBeVisible();
  const report=await (await page.request.post('/api/reception/evaluate',{headers,data:{}})).json();
  expect(report.passed).toBe(report.total);
  expect(report.providerVerified).toBe(false);
  await page.getByRole('button',{name:'Business knowledge',exact:true}).click();
  await page.getByRole('textbox',{name:'Service description',exact:true}).first().fill('Updated service description awaiting review.');
  await expect(page.getByRole('checkbox',{name:'I reviewed these business facts',exact:true})).not.toBeChecked();
  await page.getByRole('button',{name:'Save business knowledge',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('saved. Review');
  expect((await (await page.request.get('/api/knowledge')).json()).knowledge.approved).toBe(false);
});

test('local automatic reception answers approved facts and emergency off works with invalid unsaved limits', async ({page}) => {
  await login(page);await approve(page);
  await page.getByRole('button',{name:'Automatic reception',exact:true}).click();
  await page.getByRole('button',{name:'Enable automatic reception',exact:true}).click();
  await expect(page.getByText('Automatic reception is enabled',{exact:true})).toBeVisible();
  const before=(await (await page.request.get('/api/conversations/demo-conv-1?limit=100')).json()).messages.length;
  const inbound=await page.request.post('/api/demo/inbound',{headers,data:{conversationId:'demo-conv-1',text:'Hello'}});
  const response=await inbound.json();
  expect(response.automation.status).toBe('sent');
  expect(response.automation.outboundMessage.direction).toBe('outbound');
  const detail=(await (await page.request.get('/api/conversations/demo-conv-1?limit=100')).json());
  expect(detail.messages).toHaveLength(before+2);
  const currentPolicy=(await (await page.request.get('/api/automation')).json()).policy;
  await page.request.patch('/api/automation',{headers,data:{maxRepliesPerMinute:2,expectedVersion:currentPolicy.version}});
  await page.getByRole('spinbutton',{name:/Replies per minute/}).fill('0');
  await page.getByRole('button',{name:'Turn off automatic reception',exact:true}).click();
  await expect(page.getByText('Human review is the default',{exact:true})).toBeVisible();
  expect((await (await page.request.get('/api/automation')).json()).policy.enabled).toBe(false);
  const next=await page.request.post('/api/demo/inbound',{headers,data:{conversationId:'demo-conv-1',text:'Hello again'}});
  expect((await next.json()).automation).toBe(null);
  await page.getByRole('button',{name:'Inbox',exact:true}).click();
  await page.getByRole('button',{name:/Emma Wilson/}).click();
  await expect(page.locator('.messages-area').getByText(response.automation.outboundMessage.text,{exact:true})).toBeVisible();
});

test('sandbox retains a human handoff through a follow-up greeting without affecting real conversations', async ({page}) => {
  await login(page);await approve(page);
  const before=await (await page.request.get('/api/conversations')).json();
  await page.getByRole('button',{name:'Reception lab',exact:true}).click();
  for(const text of ['I smell gas. Please let me speak to a human.','Hi']) {
    await page.getByRole('textbox',{name:'Test message',exact:true}).fill(text);
    await page.getByRole('button',{name:'Add turn',exact:true}).click();
  }
  await page.getByRole('button',{name:'Preview reception decision',exact:true}).click();
  await expect(page.locator('.lab-decision')).toContainText('Needs a person');
  expect(await (await page.request.get('/api/conversations')).json()).toEqual(before);
  expect((await (await page.request.get('/api/automation')).json()).policy.enabled).toBe(false);
});

test('new reception pages meet tested accessibility checks and mobile drawer excludes hidden links', async ({page}) => {
  await login(page);
  const {default:AxeBuilder}=await import('@axe-core/playwright');
  for(const name of ['Business knowledge','Automatic reception','Reception lab']) {
    await page.getByRole('button',{name,exact:true}).click();
    await page.getByRole('heading',{name:name==='Reception lab'?'Conversation sandbox':name,exact:true}).waitFor();
    const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(scan.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
  }
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'Business knowledge',exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await expect.poll(()=>page.locator('.sidebar').evaluate(element=>element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.getByRole('button',{name:'Business knowledge',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'I reviewed these business facts',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  const mobile=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(mobile.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
});

test('AI lab preview requires an explicit sharing action and remains unsent', async ({page}) => {
  await page.route('**/api/settings',async route=>{
    const response=await route.fetch();const data=await response.json();
    await route.fulfill({response,json:{...data,integration:{...data.integration,aiConfigured:true}}});
  });
  let previews=0;
  await page.route('**/api/reception/ai-draft',async route=>{
    previews++;expect(route.request().postDataJSON().useAi).toBe(true);
    await route.fulfill({status:200,contentType:'application/json',json:{draft:{text:'Please describe the repair and your service address.',reason:'Review the suggested text.',source:'ai'},sent:false,mode:'simulation'}});
  });
  await login(page);await approve(page);
  await page.getByRole('button',{name:'Reception lab',exact:true}).click();
  await page.getByRole('textbox',{name:'Test message',exact:true}).fill('My tap is leaking.');
  await page.getByRole('button',{name:'Add turn',exact:true}).click();
  await page.getByRole('button',{name:'Preview AI draft',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('OpenAI');expect(previews).toBe(0);
  await page.getByRole('dialog').getByRole('button',{name:'Keep testing locally',exact:true}).click();expect(previews).toBe(0);
  await page.getByRole('button',{name:'Preview AI draft',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Share and generate preview',exact:true}).click();
  await expect(page.locator('.lab-ai-result')).toContainText('Please describe the repair and your service address.');
  await expect(page.locator('.lab-ai-result')).toContainText('No message was sent');expect(previews).toBe(1);
});
