let userInteracted = false;

if (typeof window !== 'undefined') {
  const markInteraction = () => {
    userInteracted = true;
    window.removeEventListener('click', markInteraction);
    window.removeEventListener('keydown', markInteraction);
    window.removeEventListener('touchstart', markInteraction);
    window.removeEventListener('scroll', markInteraction);
  };
  window.addEventListener('click', markInteraction, { once: true, passive: true });
  window.addEventListener('keydown', markInteraction, { once: true, passive: true });
  window.addEventListener('touchstart', markInteraction, { once: true, passive: true });
  window.addEventListener('scroll', markInteraction, { once: true, passive: true });
}

/**
 * Plays a soft bell-like notification chime using the Web Audio API.
 * Two sine oscillators (fundamental + perfect fifth) give a pleasant,
 * messenger-style "ding" sound. No audio files required.
 *
 * @param {number} volumePercent - Volume from 1 to 100 (default 40)
 */
export const playNotificationSound = (volumePercent = 40) => {
  if (!userInteracted) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();

    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // Scale amplitude: max 0.18 so it's never harsh even at 100%
    const amplitude = (Math.max(1, Math.min(100, volumePercent)) / 100) * 0.18;

    const DURATION = 0.7; // seconds

    /**
     * Creates one partial of the bell chord.
     * @param {number} freq - frequency in Hz
     * @param {number} gain - relative gain (0..1)
     */
    const makePartial = (freq, gain) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      // Instant attack, smooth exponential decay
      g.gain.setValueAtTime(amplitude * gain, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + DURATION);

      osc.connect(g);
      g.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + DURATION);
    };

    // G5 (784 Hz) — fundamental
    makePartial(784, 1.0);
    // D6 (1175 Hz) — perfect fifth above → warm bell overtone
    makePartial(1175, 0.45);
    // G6 (1568 Hz) — octave → brightness
    makePartial(1568, 0.15);

    // Close the context after the sound finishes to avoid leaking resources
    setTimeout(() => ctx.close(), (DURATION + 0.1) * 1000);

  } catch (err) {
    console.warn('[notificationSound] Could not play sound:', err);
  }
};
