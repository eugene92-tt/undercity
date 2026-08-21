'use strict';
/**
 * Shared websocket client: connect, identify, re-render, reconnect.
 *
 * A frozen dashboard mid-crisis with no indicator is the worst possible
 * failure mode in the room (contract §1), so connection state is surfaced
 * to the UI rather than hidden: live → amber on a missed heartbeat → red
 * with RECONNECTING on a drop.
 */
(function attachUndercity(global) {
  const RECONNECT_MIN_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  // The server pings every 20s; allow a generous margin before going amber.
  const STALE_MS = 30000;

  function connect({ hello, onState, onMessage, onStatus }) {
    let ws = null;
    let backoff = RECONNECT_MIN_MS;
    let lastFrame = Date.now();
    let closedByUs = false;

    const setStatus = (status) => onStatus && onStatus(status);

    function open() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);

      ws.addEventListener('open', () => {
        backoff = RECONNECT_MIN_MS;
        lastFrame = Date.now();
        setStatus('live');
        ws.send(JSON.stringify(hello));
      });

      ws.addEventListener('message', (event) => {
        lastFrame = Date.now();
        setStatus('live');
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'state' && onState) onState(msg);
        if (onMessage) onMessage(msg);
      });

      ws.addEventListener('close', () => {
        if (closedByUs) return;
        setStatus('down');
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch { /* close handler reconnects */ }
      });
    }

    // Browsers give no hook for a missed pong, so infer staleness from silence.
    setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrame > STALE_MS) setStatus('stale');
    }, 5000);

    open();

    return {
      send(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
          return true;
        }
        return false;
      },
      close() {
        closedByUs = true;
        if (ws) ws.close();
      },
    };
  }

  // -- small shared helpers ---------------------------------------------------

  function mmss(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function integrityClass(value) {
    if (value <= 0) return 'dark';
    if (value < 30) return 'critical';
    if (value < 60) return 'warn';
    return 'ok';
  }

  function severityPips(severity) {
    return '▲'.repeat(Math.max(1, Number(severity) || 1));
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * Audio stings, synthesised so the kit carries no media files.
   * Klaxon at R0 is the join key for every recording (contract §5).
   */
  function playSting(sound) {
    if (sound === 'silence') return;
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    const beep = (freq, start, duration, type = 'square', gainValue = 0.18) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(gainValue, now + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.05);
    };

    if (sound === 'klaxon') {
      beep(320, 0, 0.45); beep(240, 0.5, 0.45); beep(320, 1.0, 0.45);
    } else if (sound === 'chime') {
      beep(880, 0, 0.25, 'sine', 0.14); beep(1320, 0.18, 0.35, 'sine', 0.12);
    }
    setTimeout(() => ctx.close().catch(() => {}), 2500);
  }

  global.Undercity = { connect, mmss, integrityClass, severityPips, escapeHtml, playSting };
})(window);
