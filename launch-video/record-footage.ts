import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HumanCursor, injectCursor } from './cursor-helper.ts';

const ROOT = join(import.meta.dirname, '..');
const RECORDINGS_DIR = join(import.meta.dirname, 'recordings');
await mkdir(RECORDINGS_DIR, { recursive: true });

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
  throw new Error(`Port ${port} not ready`);
}

async function runScenario(scaleFactor: number, outputName: string) {
  console.log(`\n=== Recording Scenario at ${scaleFactor === 2 ? '4K (2x)' : '1080p (1x)'} ===`);

  const runId = Math.random().toString(36).slice(2, 6);
  const alexHandle = `alex_${runId}`;
  const jordanHandle = `jordan_${runId}`;
  const password = 'correct horse battery staple';

  // Pre-register Jordan via Realtime API
  console.log(`Pre-registering peer @${jordanHandle}...`);
  const jordanRes = await fetch('http://127.0.0.1:3000/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Jordan Lee',
      username: jordanHandle,
      email: `${jordanHandle}@example.test`,
      password,
    }),
  });
  const jordanData = (await jordanRes.json()) as { user: { id: string } };
  const jordanId = jordanData.user.id;
  const jordanCookie = jordanRes.headers.get('set-cookie')?.split(';')[0] ?? '';

  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${1920 * scaleFactor},${1080 * scaleFactor}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: scaleFactor,
    recordVideo: {
      dir: RECORDINGS_DIR,
      size: { width: 1920 * scaleFactor, height: 1080 * scaleFactor },
    },
  });

  const page = await context.newPage();
  const cursor = new HumanCursor(page);

  // Navigate to live app
  console.log('1. Navigating to live web app...');
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await injectCursor(page);
  await sleep(400);

  // Step 1: Sign up as Alex
  console.log('2. Signing up Alex...');
  await cursor.moveTo(960, 400, 500);
  await cursor.clickSelector('button:has-text("Sign Up")', 500);
  await sleep(300);

  await cursor.humanType('input[placeholder="Ada Lovelace"]', 'Alex Mercer', 35);
  await cursor.humanType('input[placeholder="ada"]', alexHandle, 35);
  await cursor.humanType('input[placeholder="••••••••••••"]', password, 30);
  await cursor.clickSelector('button:has-text("Create Account")', 400);
  await sleep(1200);

  // Step 2: Welcome screen -> Start chat with Jordan
  console.log('3. Starting conversation with Jordan...');
  await injectCursor(page);
  await page.waitForSelector('text=Welcome to vartalap', { timeout: 10000 });
  await cursor.moveTo(960, 480, 600);
  await sleep(400);

  await cursor.humanType('#new-handle', jordanHandle, 45);
  await sleep(250);
  await cursor.clickSelector('form button:has-text("Start")', 400);

  // Step 3: Message transcript & optimistic send
  console.log('4. In conversation transcript: composing optimistic messages...');
  await injectCursor(page);
  await page.waitForSelector('textarea', { timeout: 10000 });
  await sleep(600);

  // Move to composer textarea
  await cursor.clickSelector('textarea', 500);
  await cursor.humanType('textarea', 'Hey Jordan! Check out vartalap’s durable message spine.', 40);
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(900);

  // Send second message for burst grouping (fused corners)
  await cursor.humanType('textarea', 'Zero dropped packets. Guaranteed monotonic sequence order.', 35);
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(1000);

  // Step 4: Advance Jordan's read receipt so "Seen" watermark appears!
  console.log('5. Simulating peer Jordan reading the transcript...');
  const url = page.url();
  const convoId = url.split('/c/')[1];
  if (convoId) {
    // Get history to know latest seq
    const historyRes = await fetch(`http://127.0.0.1:3000/api/conversations/${convoId}/history`, {
      headers: { cookie: jordanCookie },
    });
    const historyData = (await historyRes.json()) as { latestSeq: string };
    if (historyData.latestSeq) {
      await fetch(`http://127.0.0.1:3000/api/conversations/${convoId}/receipt/advance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jordanCookie },
        body: JSON.stringify({
          conversationId: convoId,
          readThrough: historyData.latestSeq,
          sharedThrough: historyData.latestSeq,
        }),
      });
      // reload or re-query to display seen state
      await page.evaluate(() => {
        // trigger receipt check in store
        window.dispatchEvent(new Event('focus'));
      });
      await sleep(1200);
    }
  }

  // Step 5: Switch Theme in Settings
  console.log('6. Navigating to Settings...');
  await cursor.clickSelector('a[aria-label="Settings"]', 600);
  await sleep(800);
  await injectCursor(page);

  console.log('7. Switching to Dark Mode...');
  await cursor.clickSelector('button:has-text("Dark")', 500);
  await sleep(1000);

  // Step 6: Return to Chats & collapse pane for focus mode
  console.log('8. Returning to Chats in Dark Mode...');
  await cursor.clickSelector('a[aria-label="Chats"]', 600);
  await sleep(800);
  await injectCursor(page);

  // Click on the conversation
  await cursor.clickSelector('div[role="feed"] a', 500);
  await sleep(900);
  await injectCursor(page);

  console.log('9. Collapsing conversation sidebar for focus mode...');
  await cursor.clickSelector('button[aria-label="Toggle conversation list"]', 600);
  await sleep(1500);

  // Close page to save video
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  if (videoPath) {
    const finalMp4 = join(RECORDINGS_DIR, `${outputName}.mp4`);
    console.log(`Transcoding ${videoPath} -> ${finalMp4}...`);
    const trans = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-crf', '14',
      '-pix_fmt', 'yuv420p',
      '-r', '60',
      finalMp4,
    ], { stdio: 'inherit' });
    await new Promise((res) => trans.on('exit', res));
    console.log(`Saved ${finalMp4}`);
  }
}

async function main() {
  console.log('Ensuring background servers are up...');
  spawn('fuser', ['-k', '3000/tcp', '5173/tcp', '5433/tcp'], { stdio: 'ignore' });
  await sleep(400);

  const db = spawn('bun', ['run', 'scripts/db-local.ts'], { cwd: ROOT, stdio: 'ignore' });
  await waitForPort(5433);

  const realtime = spawn('bun', ['run', 'realtime'], { cwd: ROOT, stdio: 'ignore' });
  await waitForPort(3000);

  const web = spawn('bun', ['run', '--filter=@vartalap/web', 'dev', '--', '--port', '5173', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitForPort(5173);

  try {
    // 1. Record 1080p footage
    await runScenario(1, 'raw-1080p');
    // 2. Record 4K footage (deviceScaleFactor 2 on 1920x1080 viewport)
    await runScenario(2, 'raw-4k');
    console.log('\nAll raw footage recorded successfully!');
  } finally {
    web.kill('SIGTERM');
    realtime.kill('SIGTERM');
    db.kill('SIGTERM');
    await sleep(400);
  }
}

await main();
