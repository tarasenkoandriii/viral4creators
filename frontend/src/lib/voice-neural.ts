/** Local Silero inference. No audio or model requests go to a third party. */
export interface NeuralVoiceDetector {
  start(): Promise<void>;
  destroy(): Promise<void>;
}
export async function createNeuralVoiceDetector(
  stream: MediaStream,
  audioContext: AudioContext,
  onFrame: (probability: number, samples: Float32Array) => void,
  onError: () => void
): Promise<NeuralVoiceDetector> {
  const [ort, { Silero }, { Resampler }, { Message }] = await Promise.all([
    import('onnxruntime-web/wasm'),
    import('@ricky0123/vad-web/dist/models'),
    import('@ricky0123/vad-web/dist/resampler'),
    import('@ricky0123/vad-web/dist/messages'),
  ]);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = '/voice-vad/';
  const model = await Silero.new(ort, async () => {
    const response = await fetch('/voice-vad/silero_vad_v5.onnx', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Voice model unavailable');
    return response.arrayBuffer();
  });
  let closed = false;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | ScriptProcessorNode | undefined;
  let queue = Promise.resolve();
  let pending = 0;
  let starting: Promise<void> | undefined;
  let destroying: Promise<void> | undefined;
  const process = (frame: Float32Array) => {
    if (closed) return;
    // Slow devices must fail visibly, rather than collect unbounded audio.
    if (pending >= 64) {
      onError();
      return;
    }
    pending++;
    queue = queue
      .then(async () => {
        if (closed) return;
        const { isSpeech } = await model.process(frame);
        if (!closed) onFrame(isSpeech, frame);
      })
      .catch(() => {
        if (!closed) onError();
      })
      .finally(() => {
        pending--;
      });
  };
  const start = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Voice detector closed'));
    if (starting) return starting;
    starting = (async () => {
      if (audioContext.audioWorklet && typeof AudioWorkletNode === 'function') {
        await audioContext.audioWorklet.addModule(
          '/voice-vad/vad.worklet.bundle.min.js'
        );
        if (closed) return;
        const worklet = new AudioWorkletNode(
          audioContext,
          'vad-helper-worklet',
          {
            processorOptions: { frameSamples: 512 },
          }
        );
        worklet.port.onmessage = ({ data }) => {
          if (
            data?.message === Message.AudioFrame &&
            data.data instanceof ArrayBuffer
          ) {
            process(new Float32Array(data.data));
          }
        };
        worklet.onprocessorerror = () => {
          if (!closed) onError();
        };
        node = worklet;
      } else {
        const resampler = new Resampler({
          nativeSampleRate: audioContext.sampleRate,
          targetSampleRate: 16000,
          targetFrameSize: 512,
        });
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          for (const frame of resampler.process(
            event.inputBuffer.getChannelData(0)
          )) {
            process(frame.slice());
          }
        };
        node = processor;
      }
      if (closed) return;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(node);
      // The processor outputs silence; connecting keeps Safari's graph active.
      node.connect(audioContext.destination);
    })();
    return starting;
  };
  const destroy = (): Promise<void> => {
    if (destroying) return destroying;
    closed = true;
    destroying = (async () => {
      await starting?.catch(() => undefined);
      source?.disconnect();
      if (
        typeof AudioWorkletNode === 'function' &&
        node instanceof AudioWorkletNode
      ) {
        node.port.onmessage = null;
        node.port.postMessage(Message.SpeechStop);
        node.port.close();
      } else if (node) {
        (node as ScriptProcessorNode).onaudioprocess = null;
      }
      node?.disconnect();
      await queue;
      await model.release();
    })();
    return destroying;
  };
  return { start, destroy };
}
