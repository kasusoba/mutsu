/**
 * NOTE: twin of packages/web/src/lib/call.ts — kept in sync by hand (the web and
 * extension packages can't share a DOM-typed module via @sixseven/protocol, which
 * is DOM-free). Change both together.
 *
 * CallManager (§17) — the WebRTC half of the video call. Transport-agnostic: it
 * knows nothing about PartyKit or Svelte, just "send this signal to that peer"
 * and "here's a remote stream." That keeps it reusable (the own-tab widget can
 * drive it through its own socket later).
 *
 * Media is peer-to-peer — it never touches the server (§2 holds; the server only
 * relays tiny SDP/ICE text via `rtcSignal`). Capped to a 1:1 call server-side.
 *
 * Uses the WHATWG "perfect negotiation" pattern so both sides can fire offers at
 * once (both flip their camera on) without glare: one peer is "polite" (yields on
 * collision), decided deterministically by id so the two sides always disagree.
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

  constructor(
    private readonly self: MemberId,
    /** Relay an opaque signal to one peer (→ room.rtcSignal). */
    private readonly send: SignalSender,
    /** Fetch ICE servers (STUN/TURN) once, lazily, at media start. */
    private readonly getIce: () => Promise<RTCIceServer[]>,
    /** A peer's remote stream arrived (or null when the peer drops). */
    private readonly onStream: (id: MemberId, stream: MediaStream | null) => void,
  ) {}

  /** Acquire camera + mic. Rejects if the user denies permission. */
  async startMedia(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      this.ice = await this.getIce().catch(() => [] as RTCIceServer[]);
    }
    return this.localStream;
  }

  /** Reconcile which peers we should be connected to (other members with cam on). */
  setPeers(ids: MemberId[]): void {
    const want = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
    for (const id of want) if (!this.peers.has(id)) this.connect(id);
  }

  private connect(id: MemberId): Peer | null {
    if (!this.localStream) return null;
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

    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);

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
    let peer = this.peers.get(from);
    if (!peer) peer = this.connect(from) ?? undefined;
    if (!peer) return; // no local media yet — our own setPeers will reinitiate
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
