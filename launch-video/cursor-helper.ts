import type { Page } from 'playwright';

export interface Point {
  x: number;
  y: number;
}

export async function injectCursor(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById('virtual-cursor-layer')) return;

    const container = document.createElement('div');
    container.id = 'virtual-cursor-layer';
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100vw';
    container.style.height = '100vh';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '9999999';

    // SVG Cursor
    const cursor = document.createElement('div');
    cursor.id = 'virtual-cursor';
    cursor.style.position = 'absolute';
    cursor.style.top = '0';
    cursor.style.left = '0';
    cursor.style.transform = 'translate(100px, 100px)';
    cursor.style.transition = 'transform 0.04s linear';
    cursor.style.pointerEvents = 'none';
    cursor.innerHTML = `
      <svg width="26" height="32" viewBox="0 0 26 32" fill="none" style="filter: drop-shadow(0 3px 6px rgba(0,0,0,0.3));">
        <path d="M1 1L10.5 29L14.8 17.5L25 14L1 1Z" fill="#0f172a" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `;

    // Click Ripple
    const ripple = document.createElement('div');
    ripple.id = 'virtual-ripple';
    ripple.style.position = 'absolute';
    ripple.style.width = '36px';
    ripple.style.height = '36px';
    ripple.style.borderRadius = '50%';
    ripple.style.border = '2.5px solid rgba(14, 165, 233, 0.9)';
    ripple.style.backgroundColor = 'rgba(14, 165, 233, 0.25)';
    ripple.style.transform = 'translate(-50%, -50%) scale(0)';
    ripple.style.opacity = '0';
    ripple.style.pointerEvents = 'none';
    ripple.style.transition = 'transform 0.35s ease-out, opacity 0.35s ease-out';

    container.appendChild(cursor);
    container.appendChild(ripple);
    document.body.appendChild(container);
  });
}

export class HumanCursor {
  private current: Point = { x: 200, y: 200 };

  constructor(private page: Page) {}

  async moveTo(targetX: number, targetY: number, durationMs = 600) {
    const steps = Math.max(15, Math.floor(durationMs / 16));
    const startX = this.current.x;
    const startY = this.current.y;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Smooth sinusoidal / ease-in-out curve
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      const x = startX + (targetX - startX) * ease;
      const y = startY + (targetY - startY) * ease;

      await this.page.evaluate(({ x, y }) => {
        const c = document.getElementById('virtual-cursor');
        if (c) c.style.transform = `translate(${x}px, ${y}px)`;
      }, { x, y });

      await new Promise((r) => setTimeout(r, 16));
    }

    this.current = { x: targetX, y: targetY };
    await this.page.mouse.move(targetX, targetY);
  }

  async moveToObject(selector: string, durationMs = 600, offsetX = 0.5, offsetY = 0.5): Promise<Point> {
    const el = await this.page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    const box = await el.boundingBox();
    if (!box) throw new Error(`Bounding box null for: ${selector}`);

    const targetX = box.x + box.width * offsetX;
    const targetY = box.y + box.height * offsetY;
    await this.moveTo(targetX, targetY, durationMs);
    return { x: targetX, y: targetY };
  }

  async clickAt(x?: number, y?: number) {
    const targetX = x ?? this.current.x;
    const targetY = y ?? this.current.y;

    // Trigger visual ripple
    await this.page.evaluate(({ x, y }) => {
      const r = document.getElementById('virtual-ripple');
      if (r) {
        r.style.left = `${x}px`;
        r.style.top = `${y}px`;
        r.style.transform = 'translate(-50%, -50%) scale(0)';
        r.style.opacity = '1';
        // force reflow
        void r.offsetWidth;
        r.style.transform = 'translate(-50%, -50%) scale(1.6)';
        r.style.opacity = '0';
      }
    }, { x: targetX, y: targetY });

    await this.page.mouse.click(targetX, targetY);
    await new Promise((r) => setTimeout(r, 120));
  }

  async clickSelector(selector: string, durationMs = 600) {
    const { x, y } = await this.moveToObject(selector, durationMs);
    await this.clickAt(x, y);
  }

  async humanType(selector: string, text: string, charDelayMs = 45) {
    await this.clickSelector(selector, 400);
    for (const char of text) {
      await this.page.keyboard.type(char);
      const jitter = Math.floor(Math.random() * 25) - 10;
      await new Promise((r) => setTimeout(r, Math.max(20, charDelayMs + jitter)));
    }
  }
}
