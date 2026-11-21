import numpy as np, soundcard as sc
for s in sc.all_speakers():
    try:
        mic = sc.get_microphone(id=str(s.name), include_loopback=True)
        with mic.recorder(samplerate=16000, channels=1) as r:
            a = np.asarray(r.record(numframes=24000)).reshape(-1)
        print(f"{s.name[:42]:44} rms={float(np.sqrt(np.mean(a**2))):.4f} max={float(np.max(np.abs(a))):.3f}")
    except Exception as e:
        print(f"{s.name[:42]:44} FAIL {type(e).__name__}: {str(e)[:60]}")
