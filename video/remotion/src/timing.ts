export const FPS = 60;
export const BPM = 131;
export const BEAT = (60 / BPM) * FPS;
export const CUES = [0, 110, 330, 550, 769, 989, 1209, 1429];
export const DURATION = CUES[CUES.length - 1];
export const SHOTS = ['Summon', 'TheDrop', 'Reactor', 'MeasuredSpeed', 'Pipes', 'DropIn', 'Wraith'];
export const pulseAt = (frame: number) => Math.exp(-((frame / BEAT) % 1) * 13);
