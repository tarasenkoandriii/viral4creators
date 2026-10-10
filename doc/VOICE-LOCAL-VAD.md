# Local voice segmentation (TMA)

Continuous listening now uses pinned Silero v5 through @ricky0123/vad-web 0.0.31 and ONNX Runtime Web 1.30.0. Model probabilities drive the existing start/end/idle state machine; RMS remains for the additional barge-in amplitude guard. Frames are 512 samples at 16 kHz (32 ms), onset probability 0.3, speech 0.5, hangover 900 ms, maximum 45 seconds, idle shutoff 20 seconds. Manual push-to-talk and the server's paid STT contract are unchanged.

`predev`/`prebuild` copies the pinned model, worklet and runtime into generated `public/voice-vad/`. All requests remain on the application's origin; audio inference is local. The first use loads about 16 MB of model/runtime assets, then browser caching applies. Assets are generated from lockfile packages, not committed binaries. No CDN fallback. Model loading fails closed and leaves manual recording available.

The adapter owns the inference model and processing node; the hook owns MediaStream and AudioContext. Shutdown cancels callbacks, disconnects the graph, drains the bounded inference queue and releases model memory. Late model/worklet initialization cannot reactivate listening after disable/unmount. ScriptProcessor fallback supports older WebViews; a queue larger than 64 frames is an error rather than unbounded accumulation.

The existing Sandbox daily QA workflow runs the local model and lifecycle suites every day at 06:17 UTC, alongside its browser checks. These local suites need no Soniox credentials and incur no API charges.

Tests: `npm test` includes real-model synthetic ru/uk noise matrix (30 speech and 4 noise-only/silence cases), device lifecycle checks and neural lifecycle checks. Two synthetic phrases are regression coverage for the known constant-noise defect, not broad language/voice acceptance. Local Chromium worklet smoke: synthetic stream produces one completed utterance; after destroy, context closed and tracks ended. Soniox transcription quality and real microphone behavior are separate checks.

Remaining acceptance: real iOS/Android/Telegram devices, short commands, different voices, echo, music/background speakers and slow devices. VAD does not identify the speaker or guarantee rejection of speech from a TV. No claim of complete hands-free/streaming voice acceptance.

Sources: [browser VAD integration](https://docs.vad.ricky0123.com/user-guide/browser/), [Silero VAD](https://github.com/snakers4/silero-vad).
