// server/botManager.js
// Uses Puppeteer to launch a headless Chrome that joins the meeting
// and captures audio from the tab using the Web Audio API

const puppeteer = require('puppeteer');

class BotManager {
  constructor(meetingUrl, platform = 'Google Meet') {
    this.meetingUrl = meetingUrl;
    this.platform = platform;
    this.browser = null;
    this.page = null;
    this.audioCallback = null;
    this.isRecording = false;
  }

  async join() {
    console.log(`[Bot] Launching Chrome for: ${this.meetingUrl}`);

    this.browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--use-fake-ui-for-media-stream',   // auto-grant mic/camera
        '--use-fake-device-for-media-stream',
        '--allow-running-insecure-content',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-usermedia-screen-capturing',
        '--window-size=1280,720',
        // Use real audio capture (not fake) for actual meetings
        `--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36`
      ],
      defaultViewport: { width: 1280, height: 720 }
    });

    this.page = await this.browser.newPage();

    // Grant permissions
    const context = this.browser.defaultBrowserContext();
    await context.overridePermissions(new URL(this.meetingUrl).origin, [
      'microphone', 'camera', 'notifications'
    ]);

    // Navigate to meeting
    await this.page.goto(this.meetingUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Platform-specific join actions
    if (this.platform === 'Google Meet' || this.meetingUrl.includes('meet.google.com')) {
      await this._joinGoogleMeet();
    } else if (this.platform === 'Zoom' || this.meetingUrl.includes('zoom.us')) {
      await this._joinZoom();
    } else if (this.platform === 'Microsoft Teams' || this.meetingUrl.includes('teams.microsoft.com')) {
      await this._joinTeams();
    }

    // Start audio capture via injected Web Audio API script
    await this._startAudioCapture();

    console.log('[Bot] Successfully joined meeting and started audio capture');
  }

  async _joinGoogleMeet() {
    console.log('[Bot] Joining Google Meet...');
    try {
      // Dismiss "Sign in" if present — continue as guest
      await this.page.waitForSelector('input[data-initial-value]', { timeout: 5000 })
        .then(async el => {
          await el.type('MeetScribe Bot');
        }).catch(() => {});

      // Click "Continue without signing in" or "Ask to join"
      const btns = [
        'button[data-idom-class="nCP5yc AjY5Oe DuMIQc LQeN7 Yils2d"]',
        '[data-tooltip="Ask to join"]',
        'button[jsname="Qx7uuf"]',
      ];
      for (const sel of btns) {
        try {
          await this.page.waitForSelector(sel, { timeout: 4000 });
          await this.page.click(sel);
          break;
        } catch {}
      }

      // Mute mic and camera (we are just listening)
      await this._safeClick('[data-tooltip*="microphone"]');
      await this._safeClick('[data-tooltip*="camera"]');

      // Click "Join now" or "Ask to join"
      await this._safeClick('[data-promo-anchor-id="yaqOZe"]');
      await this._safeClick('button[jsname="Qx7uuf"]');

      await this.page.waitForTimeout(3000);
      console.log('[Bot] Google Meet joined');
    } catch (err) {
      console.warn('[Bot] Google Meet join warning:', err.message);
    }
  }

  async _joinZoom() {
    console.log('[Bot] Joining Zoom...');
    try {
      // Click "Join from browser" link
      await this.page.waitForSelector('a#btnJoinMeeting, a.preview-join-btn', { timeout: 8000 });
      await this._safeClick('a#btnJoinMeeting, a.preview-join-btn');
      await this.page.waitForTimeout(2000);

      // Enter name if prompted
      const nameInput = await this.page.$('#inputname');
      if (nameInput) {
        await nameInput.type('MeetScribe Bot');
        await this._safeClick('#joinBtn');
      }
      console.log('[Bot] Zoom joined');
    } catch (err) {
      console.warn('[Bot] Zoom join warning:', err.message);
    }
  }

  async _joinTeams() {
    console.log('[Bot] Joining MS Teams...');
    try {
      await this.page.waitForSelector('[data-tid="prejoin-join-button"], .ts-btn-primary', { timeout: 10000 });
      await this._safeClick('[data-tid="prejoin-join-button"], .ts-btn-primary');
      await this.page.waitForTimeout(3000);
      console.log('[Bot] Teams joined');
    } catch (err) {
      console.warn('[Bot] Teams join warning:', err.message);
    }
  }

  async _safeClick(selector) {
    try {
      await this.page.waitForSelector(selector, { timeout: 3000 });
      await this.page.click(selector);
    } catch {}
  }

  async _startAudioCapture() {
    console.log('[Bot] Starting audio capture via Web Audio API...');

    // Inject audio capture script into the page
    // This captures all audio playing on the page (meeting participants)
    await this.page.evaluate(() => {
      window._audioChunks = [];
      window._mediaRecorder = null;

      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();

      // Capture all audio elements and media streams on the page
      function hookAudio() {
        // Hook into all audio/video elements
        document.querySelectorAll('audio, video').forEach(el => {
          try {
            const src = ctx.createMediaElementSource(el);
            src.connect(dest);
            src.connect(ctx.destination); // Still play audio to keep meeting working
          } catch {}
        });
      }
      hookAudio();

      // Watch for new audio/video elements (participants joining)
      const obs = new MutationObserver(hookAudio);
      obs.observe(document.body, { childList: true, subtree: true });

      // Also capture the page's getUserMedia stream
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await origGetUserMedia(constraints);
        stream.getAudioTracks().forEach(track => {
          const src = ctx.createMediaStreamSource(new MediaStream([track]));
          src.connect(dest);
        });
        return stream;
      };

      // Record audio in 5-second chunks
      const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
      window._mediaRecorder = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          window._audioChunks.push(e.data);
        }
      };

      recorder.start(5000); // chunk every 5 seconds
    });

    // Poll audio chunks from the page every 5 seconds and send to transcriber
    this.isRecording = true;
    this._audioInterval = setInterval(async () => {
      if (!this.isRecording || !this.page) return;
      try {
        const chunk = await this.page.evaluate(() => {
          if (window._audioChunks.length === 0) return null;
          const blob = window._audioChunks.shift();
          return new Promise(res => {
            const reader = new FileReader();
            reader.onloadend = () => res(reader.result);
            reader.readAsDataURL(blob);
          });
        });

        if (chunk && this.audioCallback) {
          // Convert base64 dataURL to Buffer
          const base64 = chunk.split(',')[1];
          const buffer = Buffer.from(base64, 'base64');
          this.audioCallback(buffer);
        }
      } catch (err) {
        console.warn('[Bot] Audio poll error:', err.message);
      }
    }, 5000);
  }

  onAudioChunk(callback) {
    this.audioCallback = callback;
  }

  async leave() {
    console.log('[Bot] Leaving meeting...');
    this.isRecording = false;
    if (this._audioInterval) clearInterval(this._audioInterval);
    try {
      // Click leave/end button
      await this._safeClick('[data-tooltip*="Leave"], [aria-label*="Leave"], .leave-meeting-btn');
    } catch {}
    try {
      if (this.page) await this.page.close();
      if (this.browser) await this.browser.close();
    } catch {}
    console.log('[Bot] Browser closed');
  }
}

module.exports = BotManager;
