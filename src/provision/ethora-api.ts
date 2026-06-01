/**
 * Minimal, dependency-free Ethora REST client for the demo+QA harness.
 *
 * Built on Node 20+ global `fetch` / `FormData` / `Blob`. It deliberately
 * mirrors the proven flow in `@ethora/setup`'s `src/api.ts` (register/login/
 * createApp under the base app) and extends it with the pieces the harness
 * needs but `setup` does not: avatar upload, per-user profile update, and
 * room create/list/delete.
 *
 * Auth model (confirmed against the QA cluster):
 *   - The `Authorization` header carries a raw JWT, NOT `Bearer <jwt>`.
 *   - The base app's JWT authorizes register/login.
 *   - A user's JWT authorizes createApp / createRoom / PUT self profile.
 *   - An app's JWT authorizes registering users under that app.
 */

export interface ServerEndpoints {
  apiUrl: string;
  xmppWebSocket: string;
  xmppHost: string;
  xmppConference: string;
  webDomain: string;
}

/** The canonical base app exists on both clusters with domainName "app". */
export const BASE_APP_DOMAIN = "app";

export const SERVERS: Record<"qa" | "prod", ServerEndpoints> = {
  qa: {
    apiUrl: "https://api.chat-qa.ethora.com/v1",
    xmppWebSocket: "wss://xmpp.chat-qa.ethora.com/ws",
    xmppHost: "xmpp.chat-qa.ethora.com",
    xmppConference: "conference.xmpp.chat-qa.ethora.com",
    webDomain: "chat-qa.ethora.com",
  },
  prod: {
    apiUrl: "https://api.chat.ethora.com/v1",
    xmppWebSocket: "wss://xmpp.chat.ethora.com/ws",
    xmppHost: "xmpp.chat.ethora.com",
    xmppConference: "conference.xmpp.chat.ethora.com",
    webDomain: "chat.ethora.com",
  },
};

export interface AppInfo {
  _id: string;
  displayName: string;
  domainName: string;
  appToken: string;
  appSecret?: string;
}

export interface LoginUser {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  xmppPassword?: string;
  defaultWallet?: { walletAddress?: string };
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  wsToken?: string;
  user: LoginUser;
}

export interface RoomInfo {
  _id?: string;
  jid: string;
  title?: string;
  name?: string;
  pinned?: boolean;
}

export class EthoraApiError extends Error {
  status: number;
  body: string;
  constructor(method: string, url: string, status: number, body: string) {
    super(`${method} ${url} -> ${status}: ${body.slice(0, 400)}`);
    this.name = "EthoraApiError";
    this.status = status;
    this.body = body;
  }
}

export class EthoraApi {
  /** Origin without the trailing /v1 — each method adds its own /v1 or /v2. */
  readonly origin: string;

  constructor(apiUrl: string) {
    this.origin = apiUrl.replace(/\/v[12]\/?$/, "");
  }

  private async req<T = any>(
    method: string,
    path: string,
    opts: { token?: string; json?: unknown; form?: FormData } = {}
  ): Promise<T> {
    const url = `${this.origin}${path}`;
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = opts.token;
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary
    } else if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const resp = await fetch(url, { method, headers, body });
    const text = await resp.text();
    if (!resp.ok) throw new EthoraApiError(method, url, resp.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  // --- Bootstrap -----------------------------------------------------------

  /** Resolve the base app token (GET /v1/apps/get-config?domainName=app). */
  async getBaseAppConfig(domainName = BASE_APP_DOMAIN): Promise<AppInfo> {
    const data = await this.req<any>(
      "GET",
      `/v1/apps/get-config?domainName=${encodeURIComponent(domainName)}`
    );
    return (data.result || data) as AppInfo;
  }

  // --- Account / users -----------------------------------------------------

  /** Register a user under an app (the app's JWT authorizes it). v2 flow. */
  async register(
    appToken: string,
    email: string,
    firstName: string,
    lastName: string,
    password: string
  ): Promise<void> {
    await this.req("POST", "/v2/users/sign-up-with-email", {
      token: appToken,
      json: { email, firstName, lastName, password },
    });
  }

  /** Login a user under an app, returns a JWT scoped to that app. */
  async login(
    appToken: string,
    email: string,
    password: string
  ): Promise<LoginResult> {
    return this.req<LoginResult>("POST", "/v2/users/login-with-email", {
      token: appToken,
      json: { email, password },
    });
  }

  /** List apps owned by the logged-in user. */
  async listApps(userToken: string): Promise<AppInfo[]> {
    const data = await this.req<any>("GET", "/v1/apps/", { token: userToken });
    return (data.apps || data) as AppInfo[];
  }

  /** Create a new app (owner user token). Returns appToken + appSecret. */
  async createApp(
    userToken: string,
    displayName: string,
    domainName: string
  ): Promise<AppInfo> {
    const data = await this.req<any>("POST", "/v1/apps/", {
      token: userToken,
      json: {
        displayName,
        domainName,
        usersCanFree: true,
        defaultAccessProfileOpen: true,
        defaultAccessAssetsOpen: true,
      },
    });
    return (data.app || data) as AppInfo;
  }

  // --- Profile / avatar ----------------------------------------------------

  /**
   * Update the authenticated user's profile (PUT /v1/users/, multipart).
   * Optionally attaches an avatar file. The server stores it as profileImage
   * and the SDKs read it back as `profileImage` / `photoURL`.
   */
  async updateOwnProfile(
    userToken: string,
    fields: { firstName?: string; lastName?: string; description?: string },
    avatar?: { buffer: Buffer; filename: string; contentType: string }
  ): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) form.append(k, v);
    }
    if (avatar) {
      form.append(
        "file",
        new Blob([new Uint8Array(avatar.buffer)], { type: avatar.contentType }),
        avatar.filename
      );
    }
    await this.req("PUT", "/v1/users/", { token: userToken, form });
  }

  // --- Rooms ---------------------------------------------------------------

  /** Create a chat room under an app. pinned=true => SDK clients auto-join. */
  async createRoom(
    userToken: string,
    appId: string,
    title: string,
    pinned = true
  ): Promise<RoomInfo> {
    const data = await this.req<any>(
      "POST",
      `/v1/apps/${appId}/chats`,
      { token: userToken, json: { title, pinned } }
    );
    const room = data.room || data.chat || data.result || data;
    // Normalize the JID field across response shapes.
    return {
      _id: room._id,
      jid: room.jid || room.roomJid || room.chatJid,
      title: room.title ?? title,
      pinned: room.pinned ?? pinned,
    };
  }

  /** Default (pinned) rooms for an app, via the owner user token. */
  async getDefaultRooms(userToken: string, appId: string): Promise<RoomInfo[]> {
    const data = await this.req<any>(
      "GET",
      `/v1/apps/get-default-rooms/app-id/${appId}`,
      { token: userToken }
    );
    const list = data.rooms || data.result || data || [];
    return (Array.isArray(list) ? list : []).map((r: any) => ({
      _id: r._id,
      jid: r.jid || r.roomJid || r.chatJid,
      title: r.title || r.name,
      pinned: r.pinned,
    }));
  }

  /** Delete a chat room by JID (DELETE /v1/apps/{appId}/chats, body chatJid). */
  async deleteRoom(
    userToken: string,
    appId: string,
    chatJid: string
  ): Promise<void> {
    await this.req("DELETE", `/v1/apps/${appId}/chats`, {
      token: userToken,
      json: { chatJid },
    });
  }
}
