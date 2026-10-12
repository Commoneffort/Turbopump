"""Narration for the pitch video: same voice setup as ../tts.py, reading ./narration.json.

  ~/x1report/podcast/.venv/bin/python tts.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

PODCAST = Path.home() / "x1report" / "podcast"
sys.path.insert(0, str(PODCAST))
from x1podcast.tts import spoken  # noqa: E402  (the podcast's pronunciation lexicon)
from kokoro_onnx import Kokoro  # noqa: E402

VOICE, SPEED = "am_eric", 1.05
EXTRA = [
    (r"\bPyth\b", "Pith"),
    (r"\bTurbopump\b", "Turbo pump"),
    (r"\bTWAP\b", "twap"),
    (r"\bSOL\b", "Sol"),
]

here = Path(__file__).resolve().parent
out = here / "build" / "audio"
out.mkdir(parents=True, exist_ok=True)
kok = Kokoro(str(PODCAST / "models/kokoro/kokoro-v1.0.onnx"), str(PODCAST / "models/kokoro/voices-v1.0.bin"))
durations = {}
for seg in json.loads((here / "narration.json").read_text()):
    text = seg["text"]
    for pat, rep in EXTRA:
        text = re.sub(pat, rep, text)
    audio, sr = kok.create(spoken(text), voice=VOICE, speed=SPEED, lang="en-us")
    a = np.asarray(audio, dtype=np.float32).squeeze()
    sf.write(str(out / f"{seg['scene']}.wav"), a, sr)
    durations[seg["scene"]] = round(len(a) / sr, 2)
    print(f"{seg['scene']:12s} {durations[seg['scene']]:6.2f}s")
(out / "durations.json").write_text(json.dumps(durations, indent=1))
print(f"total {sum(durations.values()):.1f}s")
