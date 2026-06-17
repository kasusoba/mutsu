/**
 * CallManager (§17) — the WebRTC half of the video call. Transport-agnostic: it
 * knows nothing about PartyKit or Svelte, just "send this signal to that peer"
 * and "here's a remote stream." Reused by the room page and the own-tab widget.
 *
 * Asymmetric by design: you `join()` to connect + receive WITHOUT a camera, then
 * optionally `enableCamera()` to publish. So one person can broadcast while the
 * other just watches. Media is peer-to-peer — never through the server (§2); the
 * server only relays SDP/ICE text via `rtcSignal`. Capped to 1:1 server-side.
 *
 * Uses the WHATWG "perfect negotiation" pattern so either side can (re)offer at
 * any time — e.g. when someone turns their camera on mid-call — without glare.
 */

import type { MemberId } from "@sixseven/protocol";

type SignalSender = (to: MemberId, data: unknown) => void;

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remote: MediaStream;
}

interface Signal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export class CallManager {
  localStream: MediaStream | null = null;
  private peers = new Map<MemberId, Peer>();
  private ice: RTCIceServer[] = [];
  private iceReady = false;

  constructor(
    private readonly self: MemberId,
    /** Relay an opaque signal to one peer (→ room.rtcSignal). */
    private readonly send: SignalSender,
    /** Fetch ICE servers (STUN/TURN) once, lazily, on join. */
    private readonly getIce: () => Promise<RTCIceServer[]>,
    /** A peer's remote stream arrived (or null when the peer drops). */
    private readonly onStream: (id: MemberId, stream: MediaStream | null) => void,
  ) {}

  /** Join the call (receive-only until you enable your camera). Loads ICE. */
  async join(): Promise<void> {
    if (!this.iceReady) {
      this.ice = await this.getIce().catch(() => [] as RTCIceServer[]);
      this.iceReady = true;
    }
  }

  /** Turn the local camera + mic on: acquire media and push tracks to every
   *  peer (perfect negotiation renegotiates). Rejects if permission is denied. */
  async enableCamera(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      for (const peer of this.peers.values()) this.addLocalTracks(peer);
    }
    return this.localStream;
  }

  private addLocalTracks(peer: Peer): void {
    if (!this.localStream) return;
    const sent = new Set(peer.pc.getSenders().map((s) => s.track));
    for (const track of this.localStream.getTracks()) {
      if (!sent.has(track)) peer.pc.addTrack(track, this.localStream); // → negotiationneeded
    }
  }

  /** Reconcile which peers we should be connected to (other in-call members). */
  setPeers(ids: MemberId[]): void {
    const want = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
    for (const id of want) if (!this.peers.has(id)) this.connect(id);
  }

  private connect(id: MemberId): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    // Deterministic, opposite roles on the two ends: lexicographically-greater id
    // is the polite one (yields on offer collision).
    const peer: Peer = {
      pc,
      polite: this.self > id,
      makingOffer: false,
      ignoreOffer: false,
      remote: new MediaStream(),
    };
    this.peers.set(id, peer);

    // Publish if our camera is already on; a watch-only peer adds nothing and
    // simply answers recvonly when the other side offers.
    this.addLocalTracks(peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(id, { candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track }) => {
      peer.remote.addTrack(track);
      this.onStream(id, peer.remote);
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.send(id, { description: pc.localDescription.toJSON() });
      } catch (e) {
        console.warn("[sixseven] call: negotiation failed", e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
    };
    return peer;
  }

  /** Apply an inbound signal from a peer (perfect negotiation). */
  async handleSignal(from: MemberId, data: unknown): Promise<void> {
    const peer = this.peers.get(from) ?? this.connect(from);
    const { pc } = peer;
    const { description, candidate } = (data ?? {}) as Signal;
    try {
      if (description) {
        const collision =
          description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) this.send(from, { description: pc.localDescription.toJSON() });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e; // a candidate dropped during rollback is fine
        }
      }
    } catch (e) {
      console.warn("[sixseven] call: signal error", e);
    }
  }

  /** Enable/disable local audio or video without renegotiating. */
  setMicEnabled(on: boolean): void {
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = on;
  }
  setCamEnabled(on: boolean): void {
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = on;
  }

  /** Do we have a live camera/mic acquired (i.e. are we publishing)? */
  get publishing(): boolean {
    return this.localStream !== null;
  }

  private drop(id: MemberId): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(id);
    this.onStream(id, null);
  }

  /** Tear the whole call down: close every peer and release the camera/mic. */
  stop(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    this.localStream = null;
  }
}
