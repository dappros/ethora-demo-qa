# Ethora Platform Notes (from the demo+QA harness)

> Living engineering notes gathered while building `ethora-demo-qa` against the
> live QA cluster (`api.chat-qa.ethora.com`). Intended as input to the R&D /
> product-improvement process: protocol facts, conventions, and shortcomings,
> each with a concrete recommendation where one exists.
>
> Last updated: 2026-06-01.

## 1. Authentication

### REST
- Base app bootstrap: `GET /v1/apps/get-config?domainName=app` returns the base
  app (`646cc8dc96d4a4dc8f7b2f2d`) incl. `appToken`. The base app's JWT
  authorizes user register/login.
- Register: `POST /v2/users/sign-up-with-email` `{email,firstName,lastName,password}`,
  `Authorization: <appToken>`. No email-confirmation step (password set immediately).
- Login: `POST /v2/users/login-with-email` returns `{token, refreshToken,
  wsToken, user:{ _id, xmppUsername, xmppPassword, defaultWallet.walletAddress,
  profileImage, ... }}`.
- `Authorization` header carries a **raw JWT**, not `Bearer <jwt>`.
- Create app: `POST /v1/apps/` (user token). **`domainName` must be
  alphanumeric only** — hyphens 422 with a non-obvious validation error.

### XMPP (the important one)
- The client connects with **SASL username = `user.xmppUsername`
  (`{appId}_{userId}`)** and **password = `user.xmppPassword`**, over
  `wss://<xmppHost>/ws`.
- **🔴 SHORTCOMING — SASL mechanism.** Ethora's ejabberd uses a custom
  token-aware auth backend that only decodes the **PLAIN** SASL response. The
  QA cluster *advertises* `SCRAM-SHA-1`, so `@xmpp/client` (which picks the
  strongest advertised mechanism) selects SCRAM and the stream dies with
  `not-authorized — Response decoding failed` (Node) / `invalid-xml` (browser).
  - The **bots** already pin PLAIN; the **web and RN chat components did not**
    until this work (now patched on `tf-demo-qa-hooks`).
  - **Recommendation:** either (a) make all clients pin SASL PLAIN explicitly,
    or (b) stop advertising SCRAM-SHA-1 on the ejabberd side so the default
    negotiation lands on PLAIN. Pick one and make it consistent across
    QA/prod — today prod "works" only because it happens to advertise PLAIN
    first; QA's differing config silently breaks every default client.

## 2. Rooms

- **Rooms are created over REST, not pure XMPP**, and that REST call is what
  registers them in the DP backend so they appear in clients' room lists:
  - Create: `POST /v1/chats` `{title, type:"group"|"public", description}` →
    returns `{name, _id, title}`. The MUC JID is `${name}@${conference}`.
  - List my rooms: `GET /v1/chats/my` → `{items:[{_id,name,title,type,members:[...]}]}`.
  - Add members: `POST /v1/chats/users-access` `{chatName:<name>, members:[userId,...]}`.
  - Delete: `DELETE /v1/chats` `{chatName}`.
- Each app gets a default **"Main chat"** room at creation, with all app users
  as members.
- **🔴 SHORTCOMING — XMPP-only room creation is a dead end for clients.** A room
  created purely via the `createNewRoom` XMPP stanza (presence + setMeAsOwner +
  muc#owner config) does **not** register in the DP backend, so `GET /chats/my`
  never returns it and it never shows in the React/RN room list — even for its
  owner. Non-persistent MUC rooms are also destroyed when the last occupant
  leaves. **Recommendation:** document `POST /v1/chats` as the canonical
  room-creation path; if XMPP-created rooms are meant to be first-class,
  mod_ethora should register them in the backend on creation.
- **🟡 CONVENTION — member projection omits `profileImage`.** `GET /chats/my`
  `members[]` returns `_id, firstName, lastName, xmppUsername, description` but
  **not** `profileImage`. Clients that build their user set from the member
  list therefore render initials, not avatars (see §4).

## 3. Messages (XMPP stanzas)

- Group text: `<message to=<roomJid> type=groupchat id=...><data xmlns=<service>
  senderFirstName senderLastName fullName photo photoURL senderJID
  senderWalletAddress roomJid isSystemMessage tokenAmount .../><body>text</body></message>`.
- Avatar is read from the **`photo`** attribute (a legacy `photoURL` is also
  emitted for back-compat).
- Edit: `<message type=groupchat><replace id=<msgId> text=.../></message>`.
- Delete: `<message type=groupchat><body>wow</body><delete id=<msgId>/></message>`.
- mucsub subscribe: `<iq type=set to=<roomJid>><subscribe xmlns=urn:xmpp:mucsub:0
  nick=<localpart>><event node=urn:xmpp:mucsub:nodes:messages/>...</subscribe></iq>`.
- History via MAM (`urn:xmpp:mam:2`); paginated by last-known message id (a
  microsecond timestamp).
- `getRooms` over XMPP (`<query xmlns="ns:getrooms"/>`) returned
  `service-unavailable` on QA for our test users — the REST `/chats/my` is the
  reliable room-discovery path.

## 4. Avatars

- Upload: `PUT /v1/users/` (multipart, field `file`) sets `user.profileImage`.
- **🔴 SHORTCOMING — file server content type.** Uploaded files are served from
  `files.chat-qa.ethora.com` with `Content-Type: application/octet-stream` and
  `X-Content-Type-Options: nosniff`. Browsers therefore **refuse to render SVG**
  avatars/media in `<img>` (SVG-as-octet-stream is blocked for security). Raster
  formats (PNG/JPEG) still render. **Recommendation:** serve a correct
  `Content-Type` based on file extension/sniffed type (at minimum `image/*` for
  images) so SVG and correct caching/behaviour work.
- **🟡 Per-message avatar rendering.** The bubble renders `message.user.profileImage`,
  but the message parser (`getDataFromXml`) only set `photoURL` from the
  envelope `photo`, and the member list omits `profileImage` (see §2) — so
  incoming messages fell back to initials. Patched on `tf-demo-qa-hooks` (web +
  RN) by mapping the envelope photo onto `user.profileImage`.
  - **Web: confirmed working** — all sender avatars render as images.
  - **🔴 RN/iOS: still renders initials** even after the same fix, a clean
    rebuild (cleared Metro + expo caches, `--no-build-cache`), and verifying the
    fix is in the served bundle. The full data path was traced and is correct
    (`getDataFromXml` → `createMessageFromXml` → `addRoomMessage` reducer →
    `MessageContainer` → `Message`), yet `message.user.profileImage` is empty at
    render on RN while the **same** messages render with the photo on web.
    **Open R&D item** — the divergence is RN-specific; prime suspects: how the
    RN realtime/mucsub `<data>` element is extracted vs MAM (the `photo` attr may
    not survive the RN incoming-message path), or the message-persistence layer
    added on `main` normalising the stored `user`. Needs an interactive RN
    debug session (log `message.user` at the bubble) to localise.

## 5. SDK / build (React Native)

- The RN component (`ethora-chat-component-rn`) is **~Expo but not fully
  migrated.** Building the demo app needs a manual `npx pod-install ios` because
  `react-native-keyboard-controller` and the WebView native module are not
  Expo-autolinked via config plugins — without it the app red-screens with
  `'<module>' doesn't seem to be linked`. **Recommendation:** finish the Expo
  migration (config plugins / EAS) so `expo run:ios` is a one-command start.
- **🟡 CONVENTION — XMPP host shape differs web vs RN.** The web component's
  `xmppSettings.devServer` is the **full** `wss://host/ws` URL; the RN demo app
  takes the **bare host** and builds `wss://${host}/ws` itself. Passing the full
  URL to RN double-wraps it (`wss://wss://…/ws/ws` → ECONNERROR). Worth
  unifying the config contract across the two SDKs.
- `@react-native-async-storage/async-storage` on iOS stores large values in
  `Library/Application Support/<bundleId>/RCTAsyncLocalStorage_V1/` as a file
  named by the lowercase-hex MD5 of the key, with `manifest.json` mapping the
  key to `null`.
- Stable e2e test-ids exist and should be kept stable: web `chat_input` /
  `chat_send_button` / `chat_attach_button` / `room_row_<jid>` / `chat_message`;
  RN `chat-message-input` / `chat-send-button` / `room-<jid>`.

## 6. Things that work well (worth saying)

- Zero-friction account + app provisioning via REST; `wsToken` + immediate
  password (no email round-trip) make automated setup clean.
- Read receipts, typing indicators, MAM history, media, edit/delete all
  function correctly across web and RN once connected.
- Cross-platform parity is real: a message sent from the web client renders
  correctly (sender identity, avatar, read state) on the RN client in the same
  room, and vice-versa.
