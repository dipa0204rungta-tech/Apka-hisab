// Thin wrapper around the Web Speech API. Speech recognition is not
// available in every browser (e.g. Firefox) and needs HTTPS or localhost,
// so callers must check isSupported() and keep manual entry available.

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : undefined;

export function speechSupport() {
  if (!Recognition) return { supported: false, reason: 'Voice input is not supported in this browser. Use Chrome or Edge, or add items manually.' };
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { supported: false, reason: 'Voice input needs a secure (https) connection. Add items manually.' };
  }
  return { supported: true };
}

const ERROR_MESSAGES = {
  'not-allowed': 'Microphone permission was denied. Allow microphone access, or add items manually.',
  'service-not-allowed': 'Voice input is blocked in this browser. Add items manually.',
  'no-speech': 'No speech was heard. Tap the microphone and speak again.',
  'audio-capture': 'No microphone was found.',
  network: 'Voice recognition needs an internet connection. Add items manually.',
  'language-not-supported': 'This language is not supported for voice input here.',
};

/**
 * Listen for a single command.
 * handlers: { onInterim(text), onResult(alternatives: string[]), onError(message), onEnd() }
 * Returns a controller with stop().
 */
export function listenOnce(lang, handlers) {
  const rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 3;
  let delivered = false;

  rec.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (result.isFinal) {
      if (delivered) return; // some browsers fire the final result twice
      delivered = true;
      const alts = [];
      for (let i = 0; i < result.length; i++) alts.push(result[i].transcript.trim());
      handlers.onResult?.(alts.filter(Boolean));
    } else {
      handlers.onInterim?.(result[0].transcript);
    }
  };
  rec.onerror = (event) => {
    if (event.error === 'aborted') return;
    handlers.onError?.(ERROR_MESSAGES[event.error] || `Voice input error: ${event.error}`);
  };
  rec.onend = () => handlers.onEnd?.();
  try {
    rec.start();
  } catch (e) {
    handlers.onError?.(`Could not start the microphone: ${e.message}`);
    handlers.onEnd?.();
  }
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}

/**
 * Keep listening until stop() is called, so a whole list can be spoken in
 * one go. Each pause ends one phrase, which is delivered through onPhrase;
 * the microphone then restarts by itself. (Short phrases with automatic
 * restarts behave the same on Android and desktop Chrome, unlike the
 * browser's own `continuous` mode, which repeats text on Android.)
 *
 * handlers: { onInterim(text), onPhrase(text), onError(message), onEnd(reason) }
 * onEnd reason: 'stopped' | 'silence' | 'error'
 */
export function listenContinuous(lang, handlers, { silenceMs = 60000 } = {}) {
  let stopped = false;
  let rec = null;
  let lastHeard = Date.now();
  let quickEnds = 0;
  let startedAt = 0;
  let heardThisTime = false;
  let lastPhrase = { text: '', at: 0 };

  const finish = (reason) => {
    if (stopped && reason !== 'stopped') return;
    stopped = true;
    handlers.onEnd?.(reason);
  };

  const start = () => {
    rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const text = (result?.[0]?.transcript || '').trim();
      if (!text) return;
      lastHeard = Date.now();
      heardThisTime = true;
      if (!result.isFinal) { handlers.onInterim?.(text); return; }
      // Some phones deliver the same final phrase twice.
      if (text === lastPhrase.text && Date.now() - lastPhrase.at < 3000) return;
      lastPhrase = { text, at: Date.now() };
      handlers.onPhrase?.(text);
    };
    rec.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return; // silence: keep listening
      stopped = true;
      handlers.onError?.(ERROR_MESSAGES[event.error] || `Voice input error: ${event.error}`);
      handlers.onEnd?.('error');
    };
    rec.onend = () => {
      if (stopped) return;
      if (Date.now() - lastHeard > silenceMs) { finish('silence'); return; }
      // If the microphone keeps closing immediately without hearing anything,
      // stop instead of restarting in a tight loop.
      quickEnds = !heardThisTime && Date.now() - startedAt < 300 ? quickEnds + 1 : 0;
      if (quickEnds > 5) {
        stopped = true;
        handlers.onError?.('The microphone keeps stopping. Tap the mic to try again, or type the items.');
        handlers.onEnd?.('error');
        return;
      }
      start();
    };
    startedAt = Date.now();
    heardThisTime = false;
    try {
      rec.start();
    } catch (e) {
      stopped = true;
      handlers.onError?.(`Could not start the microphone: ${e.message}`);
      handlers.onEnd?.('error');
    }
  };

  start();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { rec?.stop(); } catch { /* already stopped */ }
      handlers.onEnd?.('stopped');
    },
  };
}
