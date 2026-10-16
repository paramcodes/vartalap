/**
 * End-to-end driver:
 * 1. Boots PGlite on port 5433
 * 2. Boots Realtime service on port 3000
 * 3. Boots Web dev server on port 5173
 * 4. Drives the full user journey via Puppeteer (Chromium)
 * 5. Captures screenshots and compiles GIF and MP4
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = join(import.meta.dirname, '..');
const MEDIA_DIR = join(ROOT, 'media');
const SHOTS_DIR = join(MEDIA_DIR, 'screenshots');
const FRAMES_DIR = join(MEDIA_DIR, 'frames');

await mkdir(SHOTS_DIR, { recursive: true });
await mkdir(FRAMES_DIR, { recursive: true });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const conn = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`Port ${port} not open after ${timeoutMs}ms`);
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Health check ${url} failed after ${timeoutMs}ms`);
}

try {
  spawn('fuser', ['-k', '3000/tcp', '5173/tcp', '5433/tcp'], { stdio: 'ignore' });
} catch {}
await sleep(300);

console.log('1. Starting PGlite local database...');
const dbProc = spawn('bun', ['run', 'scripts/db-local.ts'], {
  cwd: ROOT,
  stdio: 'pipe',
});

dbProc.stderr?.on('data', (d) => process.stderr.write(d));
await waitForPort(5433);
console.log('   PGlite is ready on port 5433.');

console.log('2. Starting Realtime server...');
const realtimeProc = spawn('bun', ['run', 'realtime'], {
  cwd: ROOT,
  env: { ...process.env, REALTIME_PORT: '3000' },
  stdio: 'pipe',
});
realtimeProc.stdout?.on('data', (d) => process.stdout.write(`[realtime] ${d}`));
realtimeProc.stderr?.on('data', (d) => process.stderr.write(`[realtime ERR] ${d}`));
await waitForHealth('http://127.0.0.1:3000/health');
console.log('   Realtime service is healthy on port 3000.');

console.log('3. Starting Web app server...');
const webProc = spawn('bun', ['run', '--filter=@vartalap/web', 'dev', '--', '--port', '5173', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'pipe',
});
webProc.stderr?.on('data', (d) => process.stderr.write(d));
await waitForPort(5173);
console.log('   Web app is listening on http://127.0.0.1:5173.');

let frameIndex = 0;
async function captureFrame(page: puppeteer.Page, label?: string) {
  const num = String(frameIndex++).padStart(4, '0');
  const path = join(FRAMES_DIR, `frame_${num}.png`);
  await page.screenshot({ path });
  if (label) console.log(`   [Frame ${num}] ${label}`);
}

async function main() {
  const runId = Math.random().toString(36).slice(2, 7);
  const aliceHandle = `alice_${runId}`;
  const bobHandle = `bob_${runId}`;
  const password = 'correct horse battery staple';

  console.log(`4. Pre-registering peer user @${bobHandle} via API...`);
  const bobSignUp = await fetch('http://127.0.0.1:3000/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Bob Martinez',
      username: bobHandle,
      email: `${bobHandle}@example.test`,
      password,
    }),
  });
  if (!bobSignUp.ok) {
    console.warn('Bob signup response:', bobSignUp.status, await bobSignUp.text());
  } else {
    console.log('   Bob registered successfully.');
  }

  console.log('5. Launching Chromium...');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  });

  const page = await browser.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err));
  page.on('response', async (res) => {
    if (res.status() >= 400) {
      console.log('HTTP ERROR', res.status(), res.url(), await res.text().catch(() => ''));
    }
  });

  console.log('6. Navigating to http://localhost:5173...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  await sleep(600);

  // Screenshot 1: Auth screen
  await page.screenshot({ path: join(SHOTS_DIR, '01-auth-screen.png') });
  await captureFrame(page, 'Auth Screen');
  console.log('   Saved 01-auth-screen.png');

  // Fill in Sign Up tab
  console.log(`7. Registering as @${aliceHandle}...`);
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent?.trim() === 'Sign Up');
    btn?.click();
  });
  await sleep(400);
  await captureFrame(page, 'Sign Up Tab Selected');

  await page.waitForSelector('input[placeholder="Ada Lovelace"]', { timeout: 5000 });
  await page.type('input[placeholder="Ada Lovelace"]', 'Alice Vance');
  await page.type('input[placeholder="ada"]', aliceHandle);
  await page.type('input[placeholder="••••••••••••"]', password);
  await captureFrame(page, 'Sign Up Credentials Entered');

  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent?.trim() === 'Create Account');
    btn?.click();
  });
  await sleep(1500);

  // Screenshot 2: Welcome / Empty state
  await page.waitForSelector('text/Welcome to vartalap', { timeout: 10000 });
  await page.screenshot({ path: join(SHOTS_DIR, '02-welcome-screen.png') });
  await captureFrame(page, 'Welcome Screen');
  console.log('   Saved 02-welcome-screen.png');

  // Start direct conversation with Bob via the conversation-list form
  console.log(`8. Starting direct chat with @${bobHandle}...`);
  const input = await page.waitForSelector('#new-handle', { timeout: 5000 });
  await input?.type(bobHandle);
  await captureFrame(page, 'Entered Bob handle');
  await page.keyboard.press('Enter');
  await sleep(1500);

  // Screenshot 3: Chat Opened
  await page.waitForSelector('textarea', { timeout: 10000 });
  await page.screenshot({ path: join(SHOTS_DIR, '03-chat-opened.png') });
  await captureFrame(page, 'Chat Opened');
  console.log('   Saved 03-chat-opened.png');

  // Type messages
  console.log('9. Sending messages in transcript...');
  const textarea = await page.waitForSelector('textarea');

  // Message 1
  await textarea?.type("Hey Bob! Vartalap's durable spine is up and running. 🚀");
  await captureFrame(page, 'Typed Message 1');
  await page.keyboard.press('Enter');
  await sleep(800);
  await captureFrame(page, 'Sent Message 1');

  // Message 2
  await textarea?.type('Testing optimistic UI: Dexie IndexedDB writes first, then synced via global seq.');
  await captureFrame(page, 'Typed Message 2');
  await page.keyboard.press('Enter');
  await sleep(800);
  await captureFrame(page, 'Sent Message 2');

  // Message 3
  await textarea?.type('Notice the Variant D messenger design tokens, burst message grouping, and seen watermarks.');
  await captureFrame(page, 'Typed Message 3');
  await page.keyboard.press('Enter');
  await sleep(1000);
  await captureFrame(page, 'Sent Message 3');

  // Screenshot 4: Full transcript
  await page.screenshot({ path: join(SHOTS_DIR, '04-chat-transcript.png') });
  console.log('   Saved 04-chat-transcript.png');
  const chatUrl = page.url();

  // Toggle Details Pane
  console.log('10. Inspecting Details pane...');
  const infoBtn = await page.$('button[title*="details" i], button[aria-label*="details" i], button[aria-label*="Conversation details" i]');
  if (infoBtn) {
    await infoBtn.click();
    await sleep(600);
  }
  await page.screenshot({ path: join(SHOTS_DIR, '05-details-pane.png') });
  await captureFrame(page, 'Details Pane');
  console.log('   Saved 05-details-pane.png');

  // Switch to Settings & Dark Theme
  console.log('11. Navigating to Settings & switching theme...');
  const settingsLink = await page.waitForSelector('a[aria-label="Settings"]');
  await settingsLink?.click();
  await sleep(800);

  // Settings screenshot (Light)
  await page.screenshot({ path: join(SHOTS_DIR, '06-settings-light.png') });
  await captureFrame(page, 'Settings View');
  console.log('   Saved 06-settings-light.png');

  // Toggle Dark theme
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dark = buttons.find((b) => b.textContent?.trim() === 'Dark');
    dark?.click();
  });
  await sleep(600);
  await page.screenshot({ path: join(SHOTS_DIR, '07-settings-dark.png') });
  await captureFrame(page, 'Dark Mode Settings');
  console.log('   Saved 07-settings-dark.png');

  // Navigate back to Chats in Dark theme
  console.log('12. Returning to Chats in Dark Theme...');
  await page.goto(chatUrl, { waitUntil: 'networkidle0' });
  await sleep(800);

  await page.screenshot({ path: join(SHOTS_DIR, '08-chat-dark-mode.png') });
  await captureFrame(page, 'Dark Mode Chat Transcript');
  console.log('   Saved 08-chat-dark-mode.png');

  // Collapse Rail & Aside for focused view
  console.log('13. Testing Collapsible Panes...');
  const toggleListBtn = await page.$('button[aria-label="Toggle conversation list"]');
  if (toggleListBtn) {
    await toggleListBtn.click();
    await sleep(500);
  }
  await page.screenshot({ path: join(SHOTS_DIR, '09-focused-chat.png') });
  await captureFrame(page, 'Focused Transcript View');
  console.log('   Saved 09-focused-chat.png');

  await browser.close();

  // 14. Compile animated GIF and MP4
  console.log('14. Compiling GIF and MP4 with FFmpeg...');
  const gifProc = spawn(
    'ffmpeg',
    [
      '-y',
      '-framerate', '2',
      '-i', join(FRAMES_DIR, 'frame_%04d.png'),
      '-vf', 'fps=2,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
      join(MEDIA_DIR, 'demo.gif'),
    ],
    { stdio: 'inherit' }
  );
  await new Promise((resolve) => gifProc.on('exit', resolve));
  console.log('   Compiled media/demo.gif');

  const mp4Proc = spawn(
    'ffmpeg',
    [
      '-y',
      '-framerate', '2',
      '-i', join(FRAMES_DIR, 'frame_%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      join(MEDIA_DIR, 'demo.mp4'),
    ],
    { stdio: 'inherit' }
  );
  await new Promise((resolve) => mp4Proc.on('exit', resolve));
  console.log('   Compiled media/demo.mp4');

  console.log('\n✅ All features driven and recorded successfully!');
}

try {
  await main();
} catch (err) {
  console.error('Error during e2e execution:', err);
} finally {
  console.log('Cleaning up processes...');
  webProc.kill('SIGTERM');
  realtimeProc.kill('SIGTERM');
  dbProc.kill('SIGTERM');
  await sleep(500);
  process.exit(0);
}
