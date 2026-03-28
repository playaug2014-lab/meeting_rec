// server/botManager.js
const puppeteer = require('puppeteer');

class BotManager {
  constructor(meetingUrl, platform = 'Google Meet') {
    this.meetingUrl = meetingUrl;
    this.platform = platform;
    this.browser = null;
    this.page = null;
    this.audioCallback = null;
    this.isRecording = false;
    this._audioInterval = null;
    this._errCount = 0;
  }

  async join() {
    console.log(`[Bot] Launching Chrome for: ${this.meetingUrl}`);

    this.browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--allow-running-insecure-content',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,720',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      defaultViewport: { width: 1280, height: 720 }
    });

    this.page = await this.browser.newPage();

    // Hide bot detection flags
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      window.chrome = { runtime: {} };
    });

    // Grant mic + camera permissions
    try {
      const origin = new URL(this.meetingUrl).origin;
      await this.browser.defaultBrowserContext().overridePermissions(origin, [
        'microphone', 'camera', 'notifications'
      ]);
    } catch (e) {
      console.warn('[Bot] Permission warning:', e.message);
    }

    // Navigate to meeting
    try {
      await this.page.goto(this.meetingUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } catch (e) {
      console.warn('[Bot] Navigation warning (continuing):', e.message);
    }

    await this._wait(4000);
    console.log('[Bot] Page loaded:', this.page.url());

    await this._joinGoogleMeet();
    await this._startAudioCapture();
    console.log('[Bot] Bot is live');
  }

  async _joinGoogleMeet() {
    console.log('[Bot] Joining Google Meet...');
    try {
      await this._wait(3000);

      // Type name if input exists
      try {
        const nameInput = await this.page.$('input[placeholder*="name"], [jsname="YPqjbf"]');
        if (nameInput) {
          await nameInput.click({ clickCount: 3 });
          await nameInput.type('MeetScribe Bot', { delay: 80 });
          await this._wait(1000);
        }
      } catch (e) {}

      // Press Escape to dismiss any popups
      try { await this.page.keyboard.press('Escape'); await this._wait(500); } catch (e) {}

      // Try clicking join button up to 10 times
      const joinSelectors = [
        '[data-promo-anchor-id="yaqOZe"]',
        'button[jsname="Qx7uuf"]',
        '[jsname="V67aGc"]',
        '[aria-label="Join now"]',
        '[aria-label="Ask to join"]',
      ];

      let joined = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        // Try known selectors
        for (const sel of joinSelectors) {
          try {
            const btn = await this.page.$(sel);
            if (btn) {
              await btn.click();
              console.log(`[Bot] Clicked: ${sel}`);
              joined = true;
              break;
            }
          } catch (e) {}
        }
        if (joined) break;

        // Try finding button by text content
        try {
          const clicked = await this.page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const b = btns.find(el => {
              const t = (el.textContent || '').toLowerCase().trim();
              return t === 'join now' || t === 'ask to join' || t === 'join';
            });
            if (b) { b.click(); return true; }
            return false;
          });
          if (clicked) { console.log('[Bot] Clicked join via text'); joined = true; break; }
        } catch (e) {}

        console.log(`[Bot] Attempt ${attempt + 1}: waiting for join button...`);
        await this._wait(2000);
      }

      await this._wait(5000);
      console.log('[Bot] Join complete. URL:', this.page.url());
    } catch (err) {
      console.warn('[Bot] Join error (continuing):', err.message);
    }
  }

  async _startAudioCapture() {
    console.log('[Bot] Starting audio capture...');
    this.isRecording = true;

    try {
      await this.page.evaluate(() => {
        window._msChunks = [];

        try {
          const ctx = new AudioContext();
          const dest = ctx.createMediaStreamDestination();

          function hookMedia() {
            document.querySelectorAll('audio, video').forEach(el => {
              if (el._msHooked) return;
              el._msHooked = true;
              try {
                const src = ctx.createMediaElementSource(el);
                src.connect(dest);
                src.connect(ctx.destination);
              } catch (e) {}
            });
          }
          hookMedia();

          new MutationObserver(hookMedia).observe(document.body, { childList: true, subtree: true });

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';

          const recorder = new MediaRecorder(dest.stream, { mimeType });
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 500) window._msChunks.push(e.data);
          };
          recorder.start(5000);
          console.log('[MeetScribe] Recorder started');
        } catch (err) {
          console.error('[MeetScribe] Recorder error:', err);
        }
      });
    } catch (e) {
      console.warn('[Bot] Audio inject warning:', e.message);
    }

    // Poll every 5 seconds
    this._audioInterval = setInterval(async () => {
      if (!this.isRecording) return;

      // Stop if page closed
      if (!this.page || this.page.isClosed()) {
        clearInterval(this._audioInterval);
        return;
      }

      try {
        const chunk = await this.page.evaluate(() => {
          if (!window._msChunks || !window._msChunks.length) return null;
          const blob = window._msChunks.shift();
          if (!blob) return null;
          return new Promise((res, rej) => {
            const r = new FileReader();
            r.onloadend = () => res(r.result);
            r.onerror = () => rej('read error');
            r.readAsDataURL(blob);
          });
        });

        if (chunk && this.audioCallback) {
          const base64 = chunk.split(',')[1];
          if (base64) {
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length > 500) this.audioCallback(buffer);
          }
        }
      } catch (err) {
        this._errCount++;
        // Only log every 10th error to avoid spam
        if (this._errCount % 10 === 1) {
          console.warn('[Bot] Audio poll error:', err.message);
        }
        // If page is destroyed, stop polling
        if (err.message && (
          err.message.includes('destroyed') ||
          err.message.includes('detached') ||
          err.message.includes('closed')
        )) {
          clearInterval(this._audioInterval);
        }
      }
    }, 5000);
  }

  onAudioChunk(callback) {
    this.audioCallback = callback;
  }

  async leave() {
    console.log('[Bot] Leaving meeting...');
    this.isRecording = false;

    if (this._audioInterval) {
      clearInterval(this._audioInterval);
      this._audioInterval = null;
    }

    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const leaveBtn = btns.find(b => {
            const t = ((b.textContent || '') + (b.getAttribute('aria-label') || '')).toLowerCase();
            return t.includes('leave') || t.includes('end call');
          });
          if (leaveBtn) leaveBtn.click();
        }).catch(() => {});
        await this._wait(1000);
        await this.page.close().catch(() => {});
      }
    } catch (e) {}

    try {
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {}

    console.log('[Bot] Browser closed');
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BotManager;
