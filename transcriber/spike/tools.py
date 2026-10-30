# The outside programs the transcriber starts. A packaged Loggie ships its own ffmpeg (a normal Mac has none) and says
# where in HIKYAKU_FFMPEG; run from source, plain `ffmpeg` on the PATH is used as before.
import os

FFMPEG = os.environ.get('HIKYAKU_FFMPEG') or 'ffmpeg'
