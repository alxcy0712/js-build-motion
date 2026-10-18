#!/usr/bin/env python3
"""
edge-tts 辅助脚本：一次调用同时产出音频与**词级**时间戳。

为什么需要它（而不是直接用 edge-tts 命令行）：
  `edge-tts --write-subtitles` 只输出**句级**字幕。
  词级时间戳必须显式把 `boundary="WordBoundary"` 传给 Communicate，
  而 CLI 没有暴露这个开关。没有词级时间戳就做不出卡拉OK逐字高亮。

用法:
  python3 scripts/edge-tts-helper.py --probe
  python3 scripts/edge-tts-helper.py --text "..." --voice zh-CN-XiaoxiaoNeural \
      --rate +8% --out-audio out.mp3 --out-json out.json

输出 JSON:
  { "ok": true, "durationSeconds": 5.2, "words": [ {"text":"每","start":0.1,"end":0.31}, ... ] }
失败时:
  { "ok": false, "error": "...", "code": "TTS_PROVIDER_UNAVAILABLE" }
"""

import argparse
import asyncio
import json
import re
import sys


def fail(message: str, code: str = "TTS_PROVIDER_UNAVAILABLE") -> None:
    json.dump({"ok": False, "code": code, "error": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(3)


def load_edge_tts():
    try:
        import edge_tts
    except Exception as exc:  # pragma: no cover - 环境相关
        fail(f"edge_tts 模块不可用: {exc}")
    version = getattr(edge_tts, "__version__", "unknown")
    release = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if not release or tuple(map(int, release.groups())) < (7, 3, 1):
        fail(f"edge-tts {version} 需要升级：python3 -m pip install --upgrade 'edge-tts>=7.3.1'（新版握手与日期解析）")
    return edge_tts


async def probe() -> None:
    edge_tts = load_edge_tts()
    json.dump({"ok": True, "module": "edge_tts", "version": edge_tts.__version__}, sys.stdout)
    sys.stdout.write("\n")


async def synthesize(text: str, voice: str, rate: str, out_audio: str, out_json: str) -> None:
    edge_tts = load_edge_tts()

    # 关键：boundary="WordBoundary"。默认是 SentenceBoundary，只能拿到句级时间戳。
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")

    words = []
    audio_bytes = bytearray()
    try:
        async for chunk in communicate.stream():
            kind = chunk["type"]
            if kind == "audio":
                audio_bytes.extend(chunk["data"])
            elif kind == "WordBoundary":
                # offset / duration 的单位是 100 纳秒
                start = chunk["offset"] / 1e7
                dur = chunk["duration"] / 1e7
                words.append({"text": chunk["text"], "start": round(start, 3), "end": round(start + dur, 3)})
    except Exception as exc:
        fail(f"合成失败: {exc}")

    if not audio_bytes:
        fail("未收到任何音频数据")

    with open(out_audio, "wb") as fh:
        fh.write(bytes(audio_bytes))

    duration = max((w["end"] for w in words), default=0.0)
    result = {"ok": True, "voice": voice, "rate": rate, "durationSeconds": round(duration, 3), "wordCount": len(words), "words": words}
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    json.dump({k: result[k] for k in ("ok", "durationSeconds", "wordCount")}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--text")
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--out-audio")
    parser.add_argument("--out-json")
    args = parser.parse_args()

    if args.probe:
        asyncio.run(probe())
        return

    if not args.text or not args.out_audio or not args.out_json:
        fail("--text / --out-audio / --out-json 都是必填", code="CLI_USAGE")

    asyncio.run(synthesize(args.text, args.voice, args.rate, args.out_audio, args.out_json))


if __name__ == "__main__":
    main()
