// ===== Transition Composer: 3段ジェスチャをTransitionPlanへ変換 =====

export const COMPOSER_PRESETS = {
  eq_echo: { name: 'EQ → Bass Swap → Echo', durationBars: 16, intro: 'eq_blend', handoff: 'bass_swap', release: 'echo' },
  perc_filter: { name: 'Percussion → Filter → Fade', durationBars: 16, intro: 'percussion', handoff: 'filter_sweep', release: 'fader' },
  low_reverb: { name: 'Low Kill → Bass Swap → Reverb', durationBars: 8, intro: 'low_kill', handoff: 'bass_swap', release: 'reverb' },
  dip_cut: { name: 'EQ → Energy Dip → Cut', durationBars: 4, intro: 'eq_blend', handoff: 'energy_dip', release: 'cut' },
};

export const DEFAULT_COMPOSITION = { ...COMPOSER_PRESETS.eq_echo, enabled: false };

const VALID = {
  intro: ['eq_blend', 'low_kill', 'percussion'],
  handoff: ['bass_swap', 'filter_sweep', 'energy_dip'],
  release: ['fader', 'echo', 'reverb', 'delay', 'cut'],
};

export function normalizeComposition(value = {}) {
  const duration = Number(value.durationBars);
  return {
    enabled: !!value.enabled,
    name: String(value.name || 'Custom Transition').slice(0, 80),
    durationBars: [4, 8, 16, 32].includes(duration) ? duration : 16,
    intro: VALID.intro.includes(value.intro) ? value.intro : 'eq_blend',
    handoff: VALID.handoff.includes(value.handoff) ? value.handoff : 'bass_swap',
    release: VALID.release.includes(value.release) ? value.release : 'echo',
  };
}

const LABELS = {
  eq_blend: 'EQ Blend', low_kill: 'Low Kill', percussion: 'Percussion In',
  bass_swap: 'Bass Swap', filter_sweep: 'Filter Sweep', energy_dip: 'Energy Dip',
  fader: 'Fader Out', echo: 'Echo Out', reverb: 'Reverb Wash', delay: 'Delay Throw', cut: 'Drop Cut',
};

export function applyComposition(plan, value) {
  const c = normalizeComposition(value);
  if (!c.enabled) return plan;
  return {
    ...plan,
    technique: 'custom_composition',
    techniqueName: c.name,
    durationBars: c.durationBars,
    beatSync: c.release !== 'cut',
    fxTail: null,
    automation: { xfCurve: 'composer', composer: { intro: c.intro, handoff: c.handoff, release: c.release } },
    timeline: [
      { bar: 1, action: `導入: ${LABELS[c.intro]}` },
      { bar: Math.max(2, Math.round(c.durationBars * 0.45)), action: `受け渡し: ${LABELS[c.handoff]}` },
      { bar: Math.max(3, Math.round(c.durationBars * 0.75)), action: `リリース: ${LABELS[c.release]}` },
      { bar: c.durationBars, action: 'Deck handoff complete' },
    ],
    reason: [`Transition Composer: ${LABELS[c.intro]} → ${LABELS[c.handoff]} → ${LABELS[c.release]}`],
  };
}
