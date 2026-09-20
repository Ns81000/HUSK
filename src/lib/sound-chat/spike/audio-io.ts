/**
 * Phase 0 spike: the microphone -> AudioContext -> ScriptProcessor half of the
 * capture pipeline, in exactly the shape the locked design requires
 * (`createScriptProcessor(1024, 1, 1)`, fed to the Rx codec one chunk at a
 * time, drained after every chunk).
 *
 * Playback, the transport state machine, Page Visibility handling and the
 * user-gesture gating in the real feature belong to Phase 1 — this file exists
 * so the Chromium fake-microphone harness can exercise the *real* capture path
 * rather than a re-implementation of it.
 */

/** Matches `CODEC_SAMPLES_PER_FRAME`; the codec resamples device rates itself. */
export const CAPTURE_FRAME_SAMPLES = 1024;

export type MicrophoneProfile = "clean" | "browser-defaults";

/**
 * WebRTC's default audio pipeline runs noise suppression, AGC and AEC, all of
 * which are hostile to an FSK tone burst. `clean` is what the feature must ask
 * for; `browser-defaults` is what a naive `getUserMedia({audio: true})` gets.
 */
function constraintsFor(profile: MicrophoneProfile): MediaTrackConstraints {
  if (profile === "clean") {
    return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  }
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

export async function requestMicrophone(profile: MicrophoneProfile): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: constraintsFor(profile) });
}

export type CaptureHandle = {
  readonly trackLabel: string;
  readonly trackSampleRate: number;
  readonly chunks: number;
  stop: () => void;
};

export type CaptureOptions = {
  context: AudioContext;
  stream: MediaStream;
  onChunk: (chunk: Float32Array) => void;
};

/**
 * Attaches the locked capture technique to an existing AudioContext: a
 * `createScriptProcessor(1024, 1, 1)` node fed by the microphone, delivering one
 * chunk per audio callback. Nothing is played back — the node is muted into the
 * destination only so Chromium keeps pulling the graph.
 */
export function attachCapture(options: CaptureOptions): CaptureHandle {
  const { context, stream, onChunk } = options;
  const track = stream.getAudioTracks()[0];
  if (track === undefined) throw new Error("the microphone stream has no audio track");

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(CAPTURE_FRAME_SAMPLES, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;

  const state = { chunks: 0 };
  processor.onaudioprocess = (event) => {
    state.chunks += 1;
    // `getChannelData` hands back a reused buffer: the consumer must finish with
    // it synchronously (the codec copies into wasm memory immediately).
    onChunk(event.inputBuffer.getChannelData(0));
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(context.destination);

  return {
    trackLabel: track.label,
    trackSampleRate: track.getSettings().sampleRate ?? 0,
    get chunks() {
      return state.chunks;
    },
    stop: () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
      // The reference implementation famously leaks this: the mic indicator
      // stays on without it.
      track.stop();
      stream.getTracks().forEach((each) => each.stop());
    },
  };
}
