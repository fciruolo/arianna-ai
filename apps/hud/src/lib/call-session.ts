import { ApiError } from './api.ts';
import type { CallInfo } from './calls.ts';

/**
 * A call from the page (D-066): WebRTC straight to apps/voice on this machine,
 * with the offer and the answer passing through the core. No STUN or TURN
 * server: nothing leaves the machine. The page hears Arianna through an
 * <audio> element and measures her voice to animate the character.
 */
export interface CallSession {
  call: CallInfo;
  /** Arianna's voice, for the page's <audio>. */
  remote: MediaStream;
  /** 0..1, how loud Arianna is now. */
  level(): number;
  setMuted(muted: boolean): void;
  hangUp(): Promise<void>;
  /** The page is closing or reloading: hang up without waiting. */
  leave(): void;
  /** The connection dropped without a hang-up. */
  onDrop(listener: () => void): void;
}

/** The offer is sent whole, with its candidates: the voice does not trickle. */
function gathered(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    // Host candidates come at once; past this, send what there is.
    window.setTimeout(resolve, ms);
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data as T;
}

export async function startCall(conversationId: string): Promise<CallSession> {
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const pc = new RTCPeerConnection({ iceServers: [] });
  const remote = new MediaStream();
  let context: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  const dropListeners: (() => void)[] = [];
  let closing = false;

  const release = () => {
    for (const track of microphone.getTracks()) track.stop();
    pc.close();
    void context?.close();
  };

  try {
    for (const track of microphone.getTracks()) pc.addTrack(track, microphone);
    // Pipecat's transport expects a data channel; nothing is sent on it today.
    pc.createDataChannel('arianna');
    pc.addEventListener('track', (event) => {
      remote.addTrack(event.track);
      if (analyser === undefined) {
        context = new AudioContext();
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(remote).connect(analyser);
      }
    });
    const dropped = () => {
      if (!closing) for (const listener of dropListeners) listener();
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropped();
      // 'disconnected' can pass by itself: hang up only if it lasts.
      else if (pc.connectionState === 'disconnected') {
        window.setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') dropped();
        }, 5000);
      }
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const local = pc.localDescription;
    if (local === null) throw new Error('no offer');
    const { call, answer } = await post<{ call: CallInfo; answer: { sdp: string; type: 'answer' } }>('/api/calls', { conversationId, sdp: local.sdp, type: local.type });
    await pc.setRemoteDescription(answer);
    const samples = new Uint8Array(256);
    return {
      call,
      remote,
      level() {
        if (analyser === undefined) return 0;
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        return peak / 128;
      },
      setMuted(muted) {
        for (const track of microphone.getAudioTracks()) track.enabled = !muted;
      },
      async hangUp() {
        closing = true;
        release();
        await post(`/api/calls/${encodeURIComponent(call.id)}/end`, {}).catch(() => undefined);
      },
      leave() {
        closing = true;
        release();
        // The page is going away: keepalive lets the request outlive it.
        void fetch(`/api/calls/${encodeURIComponent(call.id)}/end`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      },
      onDrop(listener) {
        dropListeners.push(listener);
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
