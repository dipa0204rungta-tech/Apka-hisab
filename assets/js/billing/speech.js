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
