import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AbstractTtsVoice } from '../../spec/types.ts';
import { PYTHON_CANDIDATES } from '../../utils/tts-probe.ts';
import type { TTSProvider, WordTiming } from '../types.ts';
import { probeAudio } from '../probe.ts';
import { findDoubaoVoice, type DoubaoVoiceId } from './doubao-voices.ts';

const HELPER = fileURLToPath(new URL('../../../scripts/doubao-tts-helper.py', import.meta.url));
export const DOUBAO_VOICE_MAP: Readonly<Record<AbstractTtsVoice, DoubaoVoiceId>> = {
  female_calm: 'zh_female_vv_uranus_bigtts',
  female_lively: 'zh_female_xiaohe_uranus_bigtts',
  male_calm: 'zh_male_m191_uranus_bigtts',
  male_lively: 'zh_male_taocheng_uranus_bigtts',
};

export function createDoubaoTtsProvider(): TTSProvider {
  let python: string | null = null;
  return {
    id: 'doubao', requiresNetwork: true,
    isAvailable: async () => {
      if (!process.env.DOUBAO_API_KEY?.trim() || !existsSync(HELPER)) return false;
      for (const candidate of PYTHON_CANDIDATES) {
        const result = spawnSync(candidate, [HELPER, '--probe'], { encoding: 'utf8', timeout: 5000 });
        if (result.status === 0) { python = candidate; return true; }
      }
      return false;
    },
    synthesize: async req => {
      const key = process.env.DOUBAO_API_KEY?.trim();
      if (!key || !python) throw new Error('TTS_PROVIDER_UNAVAILABLE: 请提供 DOUBAO_API_KEY，并安装 Python/websockets>=14');
      const id = Object.hasOwn(DOUBAO_VOICE_MAP, req.voice) ? DOUBAO_VOICE_MAP[req.voice as AbstractTtsVoice] : req.voice;
      const voice = findDoubaoVoice(id);
      if (!voice) throw new Error('TTS_VOICE_UNSUPPORTED: 请从 voices 返回的目录选择音色 ID');
      const rateText = req.rate ?? '+8%';
      const rate = Number(rateText.replace('%', ''));
      if (!/^[+-]?\d+%$/.test(rateText) || !Number.isInteger(rate) || rate < -50 || rate > 100) throw new Error('TTS_RATE_UNSUPPORTED: doubao 的语速范围为 -50% 到 +100%');
      mkdirSync(dirname(req.outPath), { recursive: true });
      const jsonPath = `${req.outPath}.words.json`;
      const result = spawnSync(python, [HELPER, '--text', req.text, '--speaker', voice.id,
        '--resource', voice.resourceId, '--transport', voice.transport, `--rate=${rate}`,
        '--out-audio', req.outPath, '--out-json', jsonPath],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOUBAO_API_KEY: key, PYTHONDONTWRITEBYTECODE: '1' } });
      let outcome: { ok?: boolean; error?: string } | null = null;
      try { outcome = JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? ''); } catch { /* helper failure below */ }
      if (result.error || result.status !== 0 || !outcome?.ok || !existsSync(req.outPath)) {
        const detail = outcome?.error ?? result.error?.message ?? (result.stderr?.trim() || `语音合成失败，退出码 ${result.status}`);
        throw new Error(`TTS_PROVIDER_UNAVAILABLE: ${detail.replaceAll(key, '[REDACTED]')}`);
      }
      const measured = await probeAudio(req.outPath);
      const metadata = JSON.parse(readFileSync(jsonPath, 'utf8')) as { words?: WordTiming[] };
      return { path: req.outPath, durationSeconds: measured.durationSeconds, sampleRate: measured.sampleRate,
        ...(metadata.words?.length ? { words: metadata.words } : {}) };
    },
  };
}
