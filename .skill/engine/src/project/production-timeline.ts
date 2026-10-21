import { productionHash, validateProductionRelations, type ProductionBundle } from './production.ts';
import { validateProductionTimeline, type ProductionTimeline } from './production-timeline-schema.ts';
import { buildCaptionTrack, type CaptionCue, type MeasuredNarration } from '../captions/track.ts';
import { validateSpec } from '../spec/validate.ts';
import { SPEC_DEFAULTS, type ResolvedVideoSpec } from '../spec/types.ts';
import type { GraphicKeyframe } from '../spec/graphic.ts';

export interface TimelineConflict { code: string; path: string; severity: 'hard' | 'soft'; message: string }
export type CompiledClip = ProductionTimeline['clips'][number] & {
  kind: 'image' | 'video'; startSample: number; endSample: number; sourceStartSample: number; sourceEndSample: number;
};
export type CompiledAudioPlacement = ProductionTimeline['placements'][number] & {
  kind: ProductionTimeline['takes'][number]['kind']; lineId: string | null;
  file: ProductionTimeline['takes'][number]['file']; sampleRate: 48000; durationSamples: number; endSample: number;
};
export type CompiledEvent = ProductionTimeline['events'][number] & {
  anchorSample: number | null; anchorFrame: number | null; quantizationErrorSamples: number | null; drivesGraphic: boolean;
};
export type CompiledCaptionCue = CaptionCue & {
  lineId: string; startFrame: number; endFrame: number; startSample: number; endSample: number;
};
export interface CompiledProductionTimeline {
  sourceHash: string; identity: string; profile: 'rough' | 'final'; spec: ResolvedVideoSpec | null; durationSamples: number;
  captionCues: CompiledCaptionCue[]; narrationTimings: Map<number, MeasuredNarration>; events: CompiledEvent[];
  clips: CompiledClip[]; audioPlacements: CompiledAudioPlacement[]; conflicts: TimelineConflict[];
}

export function timelineSourceHash(bundle: ProductionBundle): string {
  return productionHash({ effective: bundle.requirements.effective, script: bundle.script, shots: bundle.shots });
}

/** Compile immutable takes and placements without IO, synthesis, trimming or timing repair. */
export function compileProductionTimeline(bundle: ProductionBundle, profile: 'rough' | 'final' = 'rough'): CompiledProductionTimeline {
  const conflicts: TimelineConflict[] = [], sourceHash = timelineSourceHash(bundle);
  const add = (code: string, path: string, message: string, severity: TimelineConflict['severity'] = 'hard') => {
    conflicts.push({ code, path, severity, message });
  };
  const result: CompiledProductionTimeline = { sourceHash, identity: '', profile, spec: null, durationSamples: 0,
    captionCues: [], narrationTimings: new Map(), events: [], clips: [], audioPlacements: [], conflicts };
  const finish = () => {
    result.identity = productionHash({ sourceHash, timeline: bundle.timeline ?? null, profile, spec: result.spec });
    return result;
  };
  try { validateProductionRelations(bundle); }
  catch (error) { add('PRODUCTION_RELATIONS_INVALID', 'bundle', (error as Error).message); return finish(); }
  if (!bundle.timeline) { add('TIMELINE_REQUIRED', 'timeline', 'An explicit timeline is required.'); return finish(); }
  const timeline = structuredClone(validateProductionTimeline(bundle.timeline));
  const { effective } = bundle.requirements, fps = effective.fps, samplesPerFrame = 48000 / fps;
  const sample = (value: bigint, path: string): number => {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) { add('SAMPLE_RANGE', path, 'Sample position exceeds the supported integer range.'); return 0; }
    return Number(value);
  };
  const frameSample = (frame: number, path: string) => sample(BigInt(frame) * BigInt(samplesPerFrame), path);
  result.durationSamples = frameSample(timeline.durationFrames, 'timeline.durationFrames');
  if (timeline.sourceHash !== sourceHash) add('TIMELINE_SOURCE_STALE', 'timeline.sourceHash', 'Effective requirements, script or shots changed.');
  if (Math.round(effective.durationSeconds * 48000) !== result.durationSamples) add('DURATION_CONFLICT', 'timeline.durationFrames', 'Frame duration and effective duration must cover the same 48 kHz samples.');
  const requestedDuration = bundle.requirements.requested.hardTargets.durationSeconds;
  if (requestedDuration !== null && Math.round(requestedDuration * 48000) !== result.durationSamples) add('HARD_DURATION_CONFLICT', 'timeline.durationFrames', 'The requested hard duration must remain intact.');
  if (!bundle.script || !bundle.shots) { add('UPSTREAM_REQUIRED', 'timeline', 'Script and shots are required.'); return finish(); }
  const lines = new Map(bundle.script.lines.map(line => [line.lineId, line]));
  const plannedShots = new Map(bundle.shots.items.map(shot => [shot.shotId, shot]));
  const shots = new Map(timeline.shots.map(shot => [shot.shotId, shot]));
  const takes = new Map(timeline.takes.map(take => [take.takeId, take]));
  const placements = new Map(timeline.placements.map(placement => [placement.placementId, placement]));
  const uses = new Map(bundle.shots.assetPlan.uses.map(use => [use.useId, use]));
  const events = new Map(timeline.events.map(event => [event.eventId, event]));
  const unique = (ids: string[], path: string) => {
  };
  unique(timeline.shots.map(shot => shot.shotId), 'timeline.shots');
  unique(timeline.takes.map(take => take.takeId), 'timeline.takes');
  unique([...timeline.clips, ...timeline.placements].map(placement => placement.placementId), 'timeline.placements');
  unique(timeline.events.map(event => event.eventId), 'timeline.events');
  unique(timeline.readingGroups.map(group => group.groupId), 'timeline.readingGroups');
  let end = 0;
  timeline.shots.forEach((shot, index) => {
    const path = `timeline.shots[${index}]`, plan = plannedShots.get(shot.shotId);
    if (!plan) add('SHOT_REFERENCE', path, 'Shot must reference the approved shot plan.');
    if (shot.startFrame !== end || shot.endFrame <= shot.startFrame || shot.endFrame > timeline.durationFrames) add('SHOT_COVERAGE', path, 'Shots must cover the whole timeline consecutively.');
    const duration = (shot.endFrame - shot.startFrame) / fps;
    if (plan && (duration < plan.durationRange.minSeconds || duration > plan.durationRange.maxSeconds)) add('SHOT_DURATION', path, 'Shot duration falls outside the planned range.');
    end = shot.endFrame;
  });
  if (end !== timeline.durationFrames || timeline.shots.length !== bundle.shots.items.length) add('SHOT_COVERAGE', 'timeline.shots', 'Every planned shot must appear once and cover the video end.');
  timeline.clips.forEach((clip, index) => {
    const path = `timeline.clips[${index}]`, use = uses.get(clip.useId), shot = use && shots.get(use.shotId);
    if (!use || use.role !== 'visual' || !shot) add('CLIP_USE_REFERENCE', path, 'Clip must bind a visual use in a scheduled shot.');
    if (clip.endFrame <= clip.startFrame || clip.endFrame > timeline.durationFrames || shot && (clip.startFrame < shot.startFrame || clip.endFrame > shot.endFrame)) add('CLIP_RANGE', path, 'Clip must fit inside its assigned shot.');
    if (use && use.selection.kind !== 'video' && clip.sourceStartFrame !== 0) add('IMAGE_SOURCE_OFFSET', path, 'Still images use source frame zero.');
    if (use?.selection.kind === 'video' && use.mute && !clip.mute && effective.originalAudio === 'preserve') add('ORIGINAL_AUDIO_UNAVAILABLE', path, 'The selected video was prepared muted; prepare its original audio before preserving it.');
    const sourceEnd = BigInt(clip.sourceStartFrame) + BigInt(clip.endFrame) - BigInt(clip.startFrame);
    if (use?.sourceRange) {
      const [num, den] = use.sourceRange.timeBase.split('/').map(BigInt);
      const span = BigInt(use.sourceRange.endPts) - BigInt(use.sourceRange.startPts);
      const sourceFrames = (span * num! * BigInt(fps) + den! - 1n) / den!;
      if (sourceEnd > sourceFrames) add('CLIP_SOURCE_RANGE', path, 'Source frames exceed the selected original interval.');
    }
    result.clips.push({ ...clip, kind: use?.selection.kind === 'video' ? 'video' : 'image', startSample: frameSample(clip.startFrame, path), endSample: frameSample(clip.endFrame, path),
      sourceStartSample: frameSample(clip.sourceStartFrame, path), sourceEndSample: sample(sourceEnd * BigInt(samplesPerFrame), path) });
  });
  for (const use of uses.values()) if (use.role === 'visual' && !timeline.clips.some(clip => clip.useId === use.useId)) add('CLIP_BINDING_REQUIRED', 'timeline.clips', 'Every selected visual use needs a clip placement: ' + use.useId);
  timeline.takes.forEach((take, index) => {
    const path = `timeline.takes[${index}]`;
    if (take.kind === 'voice' ? !take.lineId || !lines.has(take.lineId) : take.lineId !== null) add('TAKE_LINE_REFERENCE', path, 'Voice takes reference a script line; other takes use lineId=null.');
    if (!/^(inputs\/(original|unpacked)|assets\/(derived|generated))\//.test(take.file.path)) add('TAKE_INPUT_PATH', path, 'Fixed takes must reside in the project input or asset domains.');
    unique([...take.words, ...take.beats].map(point => point.pointId), path);
    let wordEnd = 0;
    for (const word of take.words) {
      if (word.startSample < wordEnd || word.endSample <= word.startSample || word.endSample > take.durationSamples) add('WORD_RANGE', path, 'Words must have ordered, non-overlapping source sample ranges.');
      wordEnd = word.endSample;
    }
    if (take.beats.some((beat, i) => beat.sample >= take.durationSamples || i > 0 && beat.sample <= take.beats[i - 1]!.sample)) add('BEAT_RANGE', path, 'Beats must be increasing source points inside the take.');
  });
  timeline.placements.forEach((placement, index) => {
    const path = `timeline.placements[${index}]`, take = takes.get(placement.takeId);
    if (!take) { add('TAKE_REFERENCE', path, 'Placement must reference a fixed take.'); return; }
    if (placement.inSample >= placement.outSample || placement.outSample > take.durationSamples) add('AUDIO_SOURCE_RANGE', path, 'Placement source samples must lie inside the take.');
    const endSample = sample(BigInt(placement.startSample) + BigInt(placement.outSample) - BigInt(placement.inSample), path);
    if (endSample > result.durationSamples) add('AUDIO_OVERRUN', path, 'Audio exceeds the video end; move it or extend the approved timeline.');
    if (take.kind === 'voice' && !placement.mute && placement.gain > 0 && (placement.inSample !== 0 || placement.outSample !== take.durationSamples)) add('VOICE_TRIMMED', path, 'An audible spoken line must retain its complete take.');
    result.audioPlacements.push({ ...placement, kind: take.kind, lineId: take.lineId, file: take.file,
      sampleRate: 48000, durationSamples: take.durationSamples, endSample });
  });
  const voices = result.audioPlacements.filter(placement => placement.kind === 'voice' && !placement.mute && placement.gain > 0).sort((a, b) => a.startSample - b.startSample);
  for (const [index, voice] of voices.entries()) if (voice.endSample > (voices[index + 1]?.startSample ?? result.durationSamples)) add('VOICE_OVERLAP', 'timeline.placements', 'A complete spoken line overlaps the next spoken line.');
  timeline.events.forEach((event, index) => {
    const path = `timeline.events[${index}]`, shot = shots.get(event.shotId), planned = plannedShots.get(event.shotId);
    if (!shot || !planned?.events.some(item => item.eventId === event.eventId)) add('EVENT_REFERENCE', path, 'Event must reference its planned shot event.');
    const phases = [event.prepareFrame, event.visibleFrame, event.peakFrame, event.completeFrame, event.readingEndFrame];
    if (phases.some((frame, i) => i > 0 && frame < phases[i - 1]!) || !shot || event.prepareFrame < shot.startFrame || event.completeFrame >= shot.endFrame || event.readingEndFrame > shot.endFrame) add('EVENT_RANGE', path, 'Event phases must be ordered and fit the shot, including its reading window.');
    let anchorSample: number | null = null, anchorFrame: number | null = null, quantizationErrorSamples: number | null = null;
    if (event.anchor) {
      const anchor = event.anchor, placement = placements.get(anchor.placementId), take = placement && takes.get(placement.takeId);
      const point = anchor.kind === 'word' ? take?.words.find(word => word.pointId === anchor.pointId) : take?.beats.find(beat => beat.pointId === anchor.pointId);
      const severity = anchor.precision === 'hard' ? 'hard' : 'soft';
      if (!placement || !take || !point) add('ANCHOR_REFERENCE', path, 'Anchor needs a selected word or beat point.', severity);
      else {
        const source = 'startSample' in point ? point.startSample : point.sample;
        const known = point.basis === 'observed' || anchor.kind === 'beat' && point.basis === 'authored';
        if (!known) add('ANCHOR_TIMING_UNKNOWN', path, 'Precise anchors require an observed word or observed/authored music point.', severity);
        if (source < placement.inSample || source >= placement.outSample || 'endSample' in point && point.endSample > placement.outSample) add('ANCHOR_SOURCE_CUT', path, 'The selected source point is outside the placed audio segment.', severity);
        if (placement.mute || placement.gain === 0) add('ANCHOR_MUTED', path, 'An audible anchor requires an active audio placement.', severity);
        anchorSample = sample(BigInt(placement.startSample) + BigInt(source) - BigInt(placement.inSample) + BigInt(anchor.offsetSamples), path);
        anchorFrame = anchor.phase === 'visible' ? Math.ceil(anchorSample / samplesPerFrame) : Math.round(anchorSample / samplesPerFrame);
        quantizationErrorSamples = anchorFrame * samplesPerFrame - anchorSample;
        if (event[anchor.phase === 'visible' ? 'visibleFrame' : 'peakFrame'] !== anchorFrame) add('ANCHOR_FRAME_CONFLICT', path, 'Declared event frame differs from the sample anchor projection.', severity);
      }
    }
    const element = shot?.composition.elements?.find(element => element.id === event.eventId);
    let drivesGraphic = false;
    if (!element) add('EVENT_GRAPHIC_UNBOUND', path, 'No composition element matches eventId; this event remains a schedule record.', 'soft');
    else if (element.keyframes?.some(key => key.opacity !== undefined || key.scale !== undefined)) add('EVENT_KEYFRAME_CONFLICT', path, 'Event opacity/scale would overwrite an existing keyframe channel.');
    else if (shot && !conflicts.some(conflict => conflict.path === path && conflict.severity === 'hard')) {
      const keys = new Map<number, GraphicKeyframe>();
      const put = (frame: number, opacity: number, scale: number) => {
        const at = (frame - shot.startFrame) / (shot.endFrame - shot.startFrame);
        keys.set(at, { ...keys.get(at), at, opacity, scale });
      };
      for (const key of element.keyframes ?? []) keys.set(key.at, { ...key });
      put(shot.startFrame, 0, 0.94); put(event.prepareFrame, 0, 0.94);
      if (event.visibleFrame > shot.startFrame) put(event.visibleFrame - 1, 0, 0.94);
      put(event.visibleFrame, 1, 1); put(event.peakFrame, 1, 1.1);
      put(event.completeFrame, 1, 1); put(event.readingEndFrame, 1, 1);
      element.keyframes = [...keys.values()].sort((a, b) => a.at - b.at);
      drivesGraphic = true;
    }
    result.events.push({ ...event, anchorSample, anchorFrame, quantizationErrorSamples, drivesGraphic });
  });
  for (const planned of plannedShots.values()) for (const event of planned.events) if (!events.has(event.eventId)) add('EVENT_SCHEDULE_REQUIRED', 'timeline.events', 'Every planned event needs a schedule: ' + event.eventId);
  timeline.readingGroups.forEach((group, index) => {
    const path = `timeline.readingGroups[${index}]`, members = group.eventIds.map(id => events.get(id));
    if (members.some(event => !event)) { add('READING_EVENT_REFERENCE', path, 'Reading groups reference scheduled events.'); return; }
    const complete = Math.max(...members.map(event => event!.completeFrame));
    if (group.endFrame - complete < group.minFrames || group.endFrame > timeline.durationFrames || members.some(event => event!.readingEndFrame < group.endFrame)) add('READING_WINDOW', path, 'Complete reading starts at the last item completion and must remain visible for minFrames.');
    if (new Set(members.map(event => event!.shotId)).size !== 1) add('READING_GROUP_SHOT', path, 'A complete list reading window must keep every item in the same visible shot.');
  });
  const narration = voices.map((voice, index) => {
    const line = lines.get(voice.lineId!), take = takes.get(voice.takeId)!;
    const observedWords = take.words.length && take.words.every(word => word.basis === 'observed');
    const words = observedWords ? take.words.map(word => ({ text: word.text,
      start: (voice.startSample + word.startSample - voice.inSample) / 48000,
      end: (voice.startSample + word.endSample - voice.inSample) / 48000 })) : undefined;
    if (take.words.some(word => word.basis !== 'observed')) add('WORD_TIMING_ESTIMATED', 'timeline.takes', 'Unobserved words use estimated caption timing; exact events keep their own conflicts.', 'soft');
    result.narrationTimings.set(index, { start: voice.startSample / 48000, end: voice.endSample / 48000, ...(words ? { words } : {}) });
    return { start: voice.startSample / 48000, voice: 'female_calm' as const, text: line?.text ?? '', rate: SPEC_DEFAULTS.narrationRate };
  });
  const hasBgm = result.audioPlacements.some(placement => placement.kind === 'bgm' && !placement.mute && placement.gain > 0);
  const dimensions = profile === 'rough' ? effective.preview : effective.delivery;
  let spec: ResolvedVideoSpec | null = null;
  try {
    const projection = validateSpec({ version: '0.1', video: { ...dimensions, fps, duration: timeline.durationFrames / fps,
      seed: parseInt(productionHash(bundle.requirements.requested.rawPrompt).slice(0, 8), 16) },
      style: { palette: 'warm_night' },
      scenes: timeline.shots.map(shot => ({ id: shot.shotId, start: shot.startFrame / fps, end: shot.endFrame / fps,
        environment: 'motion_stage', camera: shot.camera, cameraMove: shot.cameraMove, transition: shot.transition,
        action: 'stand', emotion: 'neutral', composition: shot.composition })),
      audio: { narration, bgm: { preset: 'quiet_piano', key: 'C', bpm: timeline.shots[0]!.composition.bpm,
        volume: hasBgm ? 1 : 0, fadeIn: 0, fadeOut: 0, duckUnderNarration: voices.length > 0 }, sfx: [], loudness: -14 },
      captions: { enabled: voices.length > 0 || timeline.captionCues.length > 0, style: 'boxed', mode: 'sentence' } });
    if (!projection.spec || projection.issues.length || projection.schemaErrors.length) add('SPEC_PROJECTION_INVALID', 'spec', JSON.stringify({ issues: projection.issues, schemaErrors: projection.schemaErrors }));
    else spec = projection.spec;
  } catch (error) { add('SPEC_PROJECTION_INVALID', 'spec', (error as Error).message); }
  if (spec) {
    const explicitLines = new Set(timeline.captionCues.map(cue => cue.lineId));
    const cues = buildCaptionTrack(spec, { measured: result.narrationTimings }).filter(cue => !explicitLines.has(voices[cue.narrationIndex!]?.lineId ?? ''));
    for (const cue of cues) {
      const voice = voices[cue.narrationIndex!]!;
      const startSample = Math.round(cue.start * 48000), endSample = Math.round(cue.end * 48000);
      result.captionCues.push({ ...cue, start: startSample / 48000, end: endSample / 48000, lineId: voice.lineId!,
        startFrame: Math.ceil(startSample / samplesPerFrame), endFrame: Math.ceil(endSample / samplesPerFrame), startSample, endSample });
      if (cue.timingSource === 'estimated') add('CAPTION_TIMING_ESTIMATED', 'captions', 'Caption segmentation uses estimated text boundaries inside the measured take.', 'soft');
    }
    timeline.captionCues.forEach((cue, index) => {
      const path = `timeline.captionCues[${index}]`, line = lines.get(cue.lineId);
      if (!line || !(line.screenText || line.text)) add('CAPTION_LINE_REFERENCE', path, 'Caption must reference a nonempty script text.');
      if (cue.endFrame <= cue.startFrame || cue.endFrame > timeline.durationFrames) add('CAPTION_RANGE', path, 'Explicit caption frames must fit the video.');
      result.captionCues.push({ ...cue, index: 0, text: line?.screenText || line?.text || '', start: cue.startFrame / fps, end: cue.endFrame / fps,
        startSample: frameSample(cue.startFrame, path), endSample: frameSample(cue.endFrame, path), timingSource: 'estimated' });
    });
    result.captionCues.sort((a, b) => a.startSample - b.startSample);
    result.captionCues.forEach((cue, index) => {
      cue.index = index;
      if (cue.endSample > (result.captionCues[index + 1]?.startSample ?? result.durationSamples)) add('CAPTION_OVERLAP', `captions[${index}]`, 'Caption cues must retain their complete duration without overlap.');
    });
  }
  if (!conflicts.some(conflict => conflict.severity === 'hard')) result.spec = spec;
  return finish();
}
