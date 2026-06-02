import { createHash } from "node:crypto";
import { client as xmppClient, xml } from "@xmpp/client";

/**
 * Minimal Node XMPP client for the harness. Mirrors the exact stanzas the
 * React.js component sends (createRoomPresence + setMeAsOwner + roomConfig,
 * mucsub subscribe, groupchat message with the Ethora <data> envelope, and
 * muc#owner destroy) so server-side state created here is indistinguishable
 * from state created by a real client.
 *
 * Auth mirrors xmppProvider.tsx: SASL username = wallet address, password =
 * xmppPassword, both taken from the REST login response.
 */

export interface XmppIdentity {
  /** SASL username — `${appId}_${userId}` (login user.xmppUsername). */
  xmppUsername: string;
  /** SASL password — user.xmppPassword from login. */
  xmppPassword: string;
  /** Wallet address — used in the message <data> envelope, not for auth. */
  walletAddress: string;
  firstName: string;
  lastName: string;
  /** photoURL / profileImage for the message <data> envelope. */
  photo: string;
}

export class HarnessXmpp {
  private xmpp: ReturnType<typeof xmppClient> | null = null;
  private readonly service: string;
  private readonly conferenceDomain: string;
  readonly identity: XmppIdentity;
  private jidString = "";
  private localpart = "";

  constructor(opts: { service: string; conference: string; identity: XmppIdentity }) {
    this.service = opts.service;
    this.conferenceDomain = opts.conference; // e.g. conference.xmpp.chat-qa.ethora.com
    this.identity = opts.identity;
  }

  /** Connect and resolve once SASL/bind completes (online). */
  async connect(timeoutMs = 15000): Promise<void> {
    const host = this.service.match(/wss?:\/\/([^:/]+)/)?.[1] || "";
    const xmpp = xmppClient({
      service: this.service,
      domain: host,
      resource: "demo-qa",
      username: this.identity.xmppUsername,
      password: this.identity.xmppPassword,
    });
    // Force SASL PLAIN — ejabberd's custom auth only decodes PLAIN, not the
    // SCRAM-SHA-1 that @xmpp/client prefers by default. sasl.use() returns the
    // internal SASLFactory; we strip every mechanism except PLAIN.
    const factory: any = (xmpp as any).sasl.use("_NOOP", class {});
    factory._mechs = factory._mechs.filter((m: any) => m.name === "PLAIN");
    this.xmpp = xmpp;
    xmpp.on("error", () => {}); // swallow; surfaced via online/offline race below
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("xmpp connect timeout")), timeoutMs);
      xmpp.on("online", (jid: any) => {
        clearTimeout(t);
        this.jidString = jid.toString();
        this.localpart = jid.getLocal();
        resolve();
      });
      xmpp.start().catch((e: unknown) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  get jid(): string {
    return this.jidString;
  }

  private send(stanza: any): void {
    if (!this.xmpp) throw new Error("xmpp not connected");
    // @xmpp/client send() returns a promise that rejects (e.g. "Connection is
    // closing") if the socket is mid-teardown. Swallow it so a flaky send never
    // becomes an unhandled rejection that crashes the whole run.
    try {
      const r = this.xmpp.send(stanza) as unknown as { catch?: (f: () => void) => void };
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* connection gone — caller decides whether to reconnect */
    }
  }

  /** True when the XMPP stream is established. */
  get online(): boolean {
    return (this.xmpp as unknown as { status?: string } | null)?.status === "online";
  }

  private waitForIqResult(id: string, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = (stanza: any) => {
        if (stanza.is("iq") && stanza.attrs.id === id) {
          this.xmpp?.removeListener("stanza", handler);
          resolve(stanza.attrs.type === "result");
        }
      };
      this.xmpp?.on("stanza", handler);
      setTimeout(() => {
        this.xmpp?.removeListener("stanza", handler);
        resolve(false);
      }, timeoutMs);
    });
  }

  /** Compute a fresh room JID exactly like createRoom.xmpp.ts. */
  newRoomJid(title: string): string {
    const salt = title + Date.now() + Math.round(Math.random() * 100_000);
    const hash = createHash("sha256").update(salt).digest("hex");
    return `${hash}@${this.conferenceDomain}`;
  }

  /** Join (or create presence in) a room. */
  private async presence(roomJid: string, settleMs = 600): Promise<void> {
    this.send(xml("presence", { to: `${roomJid}/${this.localpart}` }, xml("x", "http://jabber.org/protocol/muc")));
    await new Promise((r) => setTimeout(r, settleMs));
  }

  /** Create a new MUC room owned by the connected user. Returns the JID. */
  async createRoom(title: string, description = ""): Promise<string> {
    const roomJid = this.newRoomJid(title);
    await this.presence(roomJid, 800); // server emits 201 (room created)
    // setMeAsOwner
    const ownerId = `set-me-as-owner:${Date.now()}`;
    this.send(
      xml("iq", { to: roomJid, id: ownerId, type: "set" },
        xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" },
          xml("x", { xmlns: "jabber:x:data", type: "submit" })))
    );
    await this.waitForIqResult(ownerId);
    await this.configureRoom(roomJid, title, description);
    return roomJid;
  }

  /**
   * Submit a muc#owner room config: name + description, persistent + public +
   * open membership. Requires the connected user to be the room owner.
   */
  async configureRoom(roomJid: string, title: string, description = ""): Promise<boolean> {
    const cfgId = `room-config:${Date.now()}`;
    const field = (varName: string, value: string) =>
      xml("field", { var: varName }, xml("value", {}, value));
    this.send(
      xml("iq", { id: cfgId, to: roomJid, type: "set" },
        xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" },
          xml("x", { xmlns: "jabber:x:data", type: "submit" },
            field("FORM_TYPE", "http://jabber.org/protocol/muc#roomconfig"),
            field("muc#roomconfig_roomname", title),
            field("muc#roomconfig_roomdesc", description),
            field("muc#roomconfig_persistentroom", "1"),
            field("muc#roomconfig_publicroom", "1"),
            field("muc#roomconfig_membersonly", "0"),
            field("muc#roomconfig_allowinvites", "1"),
            field("muc#roomconfig_changesubject", "1"))))
    );
    return this.waitForIqResult(cfgId);
  }

  /** mucsub subscribe so the room shows up in this user's getRooms list. */
  async subscribe(roomJid: string): Promise<boolean> {
    const id = `newSubscription:${Date.now()}`;
    const ok = this.waitForIqResult(id, 5000);
    this.send(
      xml("iq", { to: roomJid, type: "set", id },
        xml("subscribe", { xmlns: "urn:xmpp:mucsub:0", nick: this.localpart },
          xml("event", { node: "urn:xmpp:mucsub:nodes:messages" }),
          xml("event", { node: "urn:xmpp:mucsub:nodes:presence" })))
    );
    return ok;
  }

  /** Ensure presence + subscription (membership) for an existing room. */
  async joinAndSubscribe(roomJid: string): Promise<void> {
    await this.presence(roomJid, 500);
    await this.subscribe(roomJid);
  }

  /**
   * Query the rooms this user belongs to (mod_ethora custom getrooms). Returns
   * the room JIDs found in the response. Used to discover the app default room.
   */
  async getRooms(timeoutMs = 4000): Promise<string[]> {
    const id = "getUserRooms";
    return new Promise<string[]>((resolve) => {
      const found = new Set<string>();
      const handler = (stanza: any) => {
        if (stanza.is("iq") && stanza.attrs.id === id) {
          const text = stanza.toString();
          for (const m of text.matchAll(/[a-z0-9_]+@conference\.[a-z0-9.-]+/gi)) {
            found.add(m[0]);
          }
          this.xmpp?.removeListener("stanza", handler);
          resolve([...found]);
        }
      };
      this.xmpp?.on("stanza", handler);
      this.send(
        xml("iq", { type: "get", from: this.jidString, id }, xml("query", { xmlns: "ns:getrooms" }))
      );
      setTimeout(() => {
        this.xmpp?.removeListener("stanza", handler);
        resolve([...found]);
      }, timeoutMs);
    });
  }

  /** Send a groupchat text message with the Ethora <data> envelope. */
  async sendText(roomJid: string, text: string): Promise<void> {
    const id = `send-text-message-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    this.send(
      xml("message", { to: roomJid, type: "groupchat", id },
        xml("data", {
          xmlns: this.service,
          senderFirstName: this.identity.firstName,
          senderLastName: this.identity.lastName,
          fullName: `${this.identity.firstName} ${this.identity.lastName}`,
          photo: this.identity.photo,
          photoURL: this.identity.photo,
          senderJID: this.jidString,
          senderWalletAddress: this.identity.walletAddress,
          roomJid,
          isSystemMessage: false,
          tokenAmount: 0,
          quickReplies: "",
          notDisplayedValue: "",
          showInChannel: false,
          isReply: false,
          mainMessage: "",
          push: "true",
        }),
        xml("body", {}, text))
    );
    await new Promise((r) => setTimeout(r, 250));
  }

  /**
   * Send a media (e.g. voice note) message. The component renders audio/* via
   * its wavesurfer player from `location`, which can be an http URL or a
   * data: URI — the latter lets us ship a voice note without the file server
   * (QA's /files endpoint 500s on audio uploads).
   */
  async sendMedia(
    roomJid: string,
    media: { location: string; mimetype: string; fileName: string; duration?: number; size?: number }
  ): Promise<void> {
    const id = `send-media-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    this.send(
      xml("message", { to: roomJid, type: "groupchat", id, from: this.jidString },
        xml("body", {}, "media"),
        xml("store", { xmlns: "urn:xmpp:hints" }),
        xml("data", {
          xmlns: this.service,
          senderFirstName: this.identity.firstName,
          senderLastName: this.identity.lastName,
          fullName: `${this.identity.firstName} ${this.identity.lastName}`,
          photo: this.identity.photo,
          photoURL: this.identity.photo,
          senderJID: this.jidString,
          senderWalletAddress: this.identity.walletAddress,
          roomJid,
          isSystemMessage: false,
          isMediafile: true,
          tokenAmount: 0,
          location: media.location,
          locationPreview: media.location,
          mimetype: media.mimetype,
          fileName: media.fileName,
          originalName: media.fileName,
          size: media.size ?? 0,
          duration: media.duration ?? 0,
          isReply: false,
          push: "true",
        }))
    );
    await new Promise((r) => setTimeout(r, 250));
  }

  /** Destroy a room (muc#owner destroy). Used to clear prior-run rooms. */
  async destroyRoom(roomJid: string): Promise<boolean> {
    const id = `destroy-room:${Date.now()}`;
    const ok = this.waitForIqResult(id, 4000);
    this.send(
      xml("iq", { to: roomJid, type: "set", id },
        xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" },
          xml("destroy", {}, xml("reason", {}, "demo-qa reset"))))
    );
    return ok;
  }

  async disconnect(): Promise<void> {
    try {
      await this.xmpp?.stop();
    } catch {
      /* ignore */
    }
    this.xmpp = null;
  }
}
