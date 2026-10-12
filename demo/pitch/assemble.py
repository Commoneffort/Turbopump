"""Joins the recorded scenes (build/frames, from record.py) with their narration into
docs/pitch.mp4, with burned-in subtitles (and a separate build/pitch.srt)."""
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
B = HERE / "build"
SCENES = json.loads((HERE / "narration.json").read_text())
DUR = json.loads((B / "audio" / "durations.json").read_text())
OUT = HERE.parent.parent / "docs" / "pitch.mp4"


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def srt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


parts, cues, t = [], [], 0.0
for seg in SCENES:
    name, text = seg["scene"], seg["text"]
    frames = B / "frames" / name / "frames.txt"
    shown = sum(float(l.split()[1]) for l in frames.read_text().splitlines() if l.startswith("duration"))
    length = max(shown, DUR[name] + 1.0)
    out = B / f"part-{name}.mp4"
    # Narration starts 0.4 s in; the last frame is held if the narration runs longer.
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(frames), "-i", str(B / "audio" / f"{name}.wav"),
         "-filter_complex",
         "[0:v]fps=30,scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=6,format=yuv420p[v];[1:a]adelay=400|400,apad[a]",
         "-map", "[v]", "-map", "[a]", "-t", f"{length:.2f}",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(out)])
    d = probe(out)
    sentences = [x.strip() for x in re.split(r"(?<=[.?])\s+", text) if x.strip()]
    total = sum(len(s) for s in sentences)
    c = t + 0.4
    for s in sentences:
        dd = DUR[name] * len(s) / total
        cues.append((c, c + dd, s))
        c += dd
    parts.append(out)
    t += d
    print(f"{name:8s} {d:6.2f}s")

(B / "pitch.srt").write_text("\n".join(f"{i + 1}\n{srt_time(a)} --> {srt_time(b)}\n{s}\n" for i, (a, b, s) in enumerate(cues)))
(B / "list.txt").write_text("".join(f"file '{p}'\n" for p in parts))
run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(B / "list.txt"), "-c", "copy", str(B / "joined.mp4")])
style = "FontName=DejaVu Sans,FontSize=15,PrimaryColour=&H00F4F4F4,BackColour=&HB0121212,BorderStyle=4,Outline=0,Shadow=0,MarginV=22"
run(["ffmpeg", "-y", "-i", str(B / "joined.mp4"), "-vf", f"subtitles={B / 'pitch.srt'}:force_style='{style}'",
     "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(OUT)])
print(f"total {t:.1f}s -> {OUT}")
