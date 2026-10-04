// Microphone capture of the voice trial page (D-066): copies each block of
// samples of the first channel to the page, which downsamples them to 16 kHz.
// A file of its own because the Content-Security-Policy allows 'self' scripts only.
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('arianna-recorder', Recorder);
