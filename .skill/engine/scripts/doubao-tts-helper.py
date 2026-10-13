"""Synthesize one narration take; credentials are read from the environment."""

import argparse
import asyncio
import base64
import gzip
import json
import os
import struct
import sys
import urllib.request
import uuid
import wave
from pathlib import Path


def packet(event, body, session_id=None):
    payload = json.dumps(body, ensure_ascii=False).encode()
    result = b"\x11\x14\x10\x00" + struct.pack(">i", event)
    if session_id is not None:
        identity = session_id.encode()
        result += struct.pack(">I", len(identity)) + identity
    return result + struct.pack(">I", len(payload)) + payload


def parse(data):
    kind, event, code = data[1] >> 4, None, None
    offset = (data[0] & 15) * 4
    if kind == 15:
        code = struct.unpack_from(">I", data, offset)[0]
        offset += 4
    elif data[1] & 4:
        event = struct.unpack_from(">i", data, offset)[0]
        offset += 4
        size = struct.unpack_from(">I", data, offset)[0]
        offset += 4 + size
    size = struct.unpack_from(">I", data, offset)[0]
    payload = data[offset + 4:offset + 4 + size]
    if len(payload) != size:
        raise ValueError("Truncated WebSocket payload")
    if data[2] & 15 == 1:
        payload = gzip.decompress(payload)
    if kind == 15 or event in (51, 153):
        raise RuntimeError(f"TTS server error {code}: {payload.decode(errors='replace')}")
    return kind, event, payload


def add_words(words, body):
    for word in body.get("words", []):
        words.append({"text": word["word"], "start": word["startTime"], "end": word["endTime"]})


async def websocket_synthesis(headers, params):
    import websockets

    audio, words = bytearray(), []
    headers = {**headers, "X-Api-Connect-Id": str(uuid.uuid4())}
    async with websockets.connect("wss://openspeech.bytedance.com/api/v3/tts/bidirection",
                                  additional_headers=headers, open_timeout=15, close_timeout=5,
                                  max_size=10 * 1024 * 1024) as ws:
        async def receive():
            return parse(await asyncio.wait_for(ws.recv(), 20))

        async def expect(expected):
            _, received, _ = await receive()
            if received != expected:
                raise RuntimeError(f"Expected TTS event {expected}, received {received}")

        await ws.send(packet(1, {}))
        await expect(50)
        session_id = str(uuid.uuid4())
        settings = {key: value for key, value in params.items() if key != "text"}
        await ws.send(packet(100, {"event": 100, "namespace": "BidirectionalTTS",
                                  "user": {"uid": "video-narration"}, "req_params": settings}, session_id))
        await expect(150)
        await ws.send(packet(200, {"event": 200, "namespace": "BidirectionalTTS",
                                  "req_params": {"text": params["text"]}}, session_id))
        await ws.send(packet(102, {}, session_id))
        while True:
            kind, event, payload = await receive()
            if kind == 11:
                audio.extend(payload)
            elif event in (351, 364):
                add_words(words, json.loads(payload))
            elif event == 152:
                break
        await ws.send(packet(2, {}))
        await expect(52)
    return audio, words


def http_synthesis(headers, params):
    request = urllib.request.Request("https://openspeech.bytedance.com/api/v3/tts/unidirectional",
                                     data=json.dumps({"req_params": params}).encode(),
                                     headers={**headers, "Content-Type": "application/json",
                                              "X-Api-Request-Id": str(uuid.uuid4())})
    audio, words, finished = bytearray(), [], False
    with urllib.request.urlopen(request, timeout=45) as response:
        for line in response:
            if not line.strip():
                continue
            body = json.loads(line)
            if body.get("code") not in (0, 20000000):
                raise RuntimeError(f"TTS server error: {body.get('code')} {body.get('message')}")
            if body.get("data"):
                audio.extend(base64.b64decode(body["data"], validate=True))
            if body.get("sentence"):
                add_words(words, body["sentence"])
            if body.get("code") == 20000000:
                finished = True
    if not finished:
        raise RuntimeError("TTS response ended before the completion record")
    return audio, words


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--text")
    parser.add_argument("--speaker")
    parser.add_argument("--resource", choices=["seed-tts-1.0", "seed-tts-2.0"])
    parser.add_argument("--transport", choices=["websocket", "http"])
    parser.add_argument("--rate", type=int, default=8)
    parser.add_argument("--out-audio")
    parser.add_argument("--out-json")
    args = parser.parse_args()
    key = os.environ.get("DOUBAO_API_KEY", "").strip()
    try:
        if args.probe:
            import websockets
            if int(websockets.__version__.split(".")[0]) < 14:
                raise RuntimeError("Requires websockets>=14")
            print(json.dumps({"ok": True}))
            return
        if not key:
            raise RuntimeError("DOUBAO_API_KEY is required")
        if not all([args.text, args.speaker, args.resource, args.transport, args.out_audio, args.out_json]):
            raise ValueError("Text, voice, resource, transport and output paths are required")
        audio_params = {"format": "pcm", "sample_rate": 24000, "speech_rate": args.rate}
        timestamp_key = "enable_subtitle" if args.resource == "seed-tts-2.0" else "enable_timestamp"
        audio_params[timestamp_key] = True
        params = {"speaker": args.speaker, "text": args.text, "audio_params": audio_params}
        headers = {"X-Api-Key": key, "X-Api-Resource-Id": args.resource}
        if args.transport == "http":
            audio, words = http_synthesis(headers, params)
        else:
            audio, words = asyncio.run(asyncio.wait_for(websocket_synthesis(headers, params), 50))
        if not audio or len(audio) % 2:
            raise RuntimeError("No complete PCM16 audio received")
        Path(args.out_audio).parent.mkdir(parents=True, exist_ok=True)
        with wave.open(args.out_audio, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            output.writeframes(audio)
        Path(args.out_json).write_text(json.dumps({"speaker": args.speaker, "resourceId": args.resource,
                                                  "transport": args.transport, "rate": args.rate,
                                                  "sampleRate": 24000, "words": words}, ensure_ascii=False) + "\n")
        print(json.dumps({"ok": True}))
    except Exception as error:
        detail = str(error).replace(key, "[REDACTED]") if key else str(error)
        print(json.dumps({"ok": False, "error": detail}))
        sys.exit(1)


if __name__ == "__main__":
    main()
