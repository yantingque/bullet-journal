import os
import sys
import json
from pathlib import Path

import av
import ctranslate2
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio


def report(stage, **details):
    print("journal-progress=" + json.dumps({"stage": stage, **details}), file=sys.stderr, flush=True)


def transcribe(model_path, samples, duration, device):
    report("loading", device=device)
    compute_type = "int8_float16" if device == "cuda" else "int8"
    model = WhisperModel(model_path, device=device, compute_type=compute_type, local_files_only=True)
    report("transcribing", device=device, percent=0)
    segments, _ = model.transcribe(samples, task="transcribe", vad_filter=True)
    lines = []
    previous_percent = 0
    for segment in segments:
        elapsed = int(segment.start)
        text = segment.text.strip()
        if text:
            lines.append(f"[{elapsed // 60:02d}:{elapsed % 60:02d}] {text}")
        percent = min(99, int(100 * segment.end / duration))
        if percent > previous_percent:
            report("transcribing", device=device, percent=percent)
            previous_percent = percent
    print(f"journal-transcription-device={device}", file=sys.stderr)
    return lines


def main():
    model_path, audio_path = sys.argv[1:]
    with av.open(audio_path, timeout=20) as audio:
        if not audio.streams.audio or (audio.duration and audio.duration > 7200 * av.time_base):
            raise ValueError("Expected an audio recording under two hours")
    report("reading")
    samples = decode_audio(audio_path)
    duration = len(samples) / 16000
    if duration <= 0 or duration > 7200:
        raise ValueError("Expected a recording from zero to two hours")

    device = os.environ.get("JOURNAL_MEETING_DEVICE", "auto")
    if device not in {"auto", "cpu", "cuda"}:
        raise ValueError("JOURNAL_MEETING_DEVICE must be auto, cpu, or cuda")

    if os.name == "nt" and device != "cpu":
        libraries = Path(sys.prefix, "Lib", "site-packages", "nvidia")
        directories = list(libraries.glob("*/bin")) + list(libraries.glob("*/lib"))
        if directories:
            os.environ["PATH"] = os.pathsep.join([*map(str, directories), os.environ.get("PATH", "")])

    if device == "auto" and duration > 30:
        try:
            if ctranslate2.get_cuda_device_count() > 0:
                return transcribe(model_path, samples, duration, "cuda")
        except RuntimeError as error:
            print(f"CUDA transcription failed; retrying on CPU: {error}", file=sys.stderr)
            report("fallback")
    return transcribe(model_path, samples, duration, "cpu" if device == "auto" else device)


if __name__ == "__main__":
    lines = main()
    if lines:
        print("\n".join(lines))
