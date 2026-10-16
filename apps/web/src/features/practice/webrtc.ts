const ICE_GATHERING_TIMEOUT_MS = 3_000;

/**
 * One browser practice call: microphone up, agent audio down, over WebRTC to
 * the voice agent. Signalling goes through the API, which keeps the session
 * credentials server side.
 */
export class PracticeConnection {
  private peer?: RTCPeerConnection;
  private microphone?: MediaStream;
  private readonly speaker = new Audio();
  private closed = false;

  constructor(private readonly onEnded: () => void) {
    this.speaker.autoplay = true;
  }

  async start(exchange: (offerSdp: string) => Promise<string>): Promise<void> {
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      throw new Error(
        'Microphone access is required for practice. Allow access and try again.',
      );
    }
    if (this.closed) return this.release();
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of this.microphone.getAudioTracks())
      peer.addTrack(track, this.microphone);
    peer.ontrack = (event) => {
      this.speaker.srcObject =
        event.streams[0] ?? new MediaStream([event.track]);
      void this.speaker.play().catch(() => {});
    };
    peer.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState))
        this.stop();
    };
    await peer.setLocalDescription(await peer.createOffer());
    // The voice agent does not trickle ICE, so send the offer with its candidates.
    await iceGatheringComplete(peer);
    const answer = await exchange(peer.localDescription!.sdp);
    if (this.closed) return;
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.onEnded();
  }

  private release(): void {
    this.peer?.close();
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.speaker.srcObject = null;
  }
}

function iceGatheringComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener('icegatheringstatechange', check);
  });
}
