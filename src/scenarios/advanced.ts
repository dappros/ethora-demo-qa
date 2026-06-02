import type { Scenario } from "./types.js";
import { midsummer } from "./midsummer.js";

/**
 * Advanced features + resilience showcase. Reuses the Midsummer cast but
 * focuses on the richer SDK surface (reactions, threaded replies, voice notes)
 * and the robustness cases enterprise integrators worry about (reconnect /
 * offline backfill, multi-room switching). More QA-leaning than the polished
 * Midsummer happy-path, but still reads as a real conversation.
 */
export const advanced: Scenario = {
  id: "advanced",
  title: "Ethora Advanced Features and Resilience",
  theme: "Advanced chat features and connection resilience",
  roomTitle: "The Forest",
  secondRoomTitle: "The Palace of Theseus",
  avatarStyle: "adventurer",
  cast: midsummer.cast,
  heroes: midsummer.heroes,

  history: [
    { actor: "oberon", text: "Ill met by moonlight, proud Titania." },
    { actor: "puck", text: "I'll put a girdle round about the earth in forty minutes." },
  ],
  secondRoomHistory: [
    { actor: "titania", text: "These are the forgeries of jealousy." },
    { actor: "demetrius", text: "Are you sure that we are awake?" },
  ],

  script: [
    { kind: "screenshot", surface: "both", label: "00-room-open", note: "Both clients in The Forest." },
    { kind: "wait", ms: 2500 },

    // A message to react to.
    { kind: "message", actor: "lysander", text: "Shall we meet in the wood a league without the town?",
      caption: "Mobile (iOS) sends a message" },

    // Reactions (both render on the message).
    { kind: "reaction", actor: "hermia", targetText: "meet in the wood", emoji: "heart",
      caption: "React to a message with an emoji" },
    { kind: "reaction", actor: "hermia", targetText: "meet in the wood", emoji: "fire" },
    { kind: "screenshot", surface: "web", label: "01-reactions" },

    // NOTE: a `voice` beat is supported by the engine, but omitted here — QA's
    // file server 500s on audio uploads and data-URI media doesn't render, so a
    // voice note can't be demonstrated end-to-end on QA (see docs/PLATFORM-NOTES.md).
    // It works on a server that accepts audio uploads (prod / self-hosted).

    // Resilience: drop the network; a message sent during the outage backfills.
    { kind: "reconnect", offlineMs: 4500, duringOffline: [
        { actor: "puck", text: "Lord, what fools these mortals be!" },
      ],
      caption: "Network drops, then reconnects and backfills the missed message" },
    { kind: "screenshot", surface: "web", label: "03-reconnect-backfill" },

    // Resilience: multi-room switching (per-room state survives).
    { kind: "switchRoom",
      caption: "Switch to another room and back (per-room state preserved)" },
    { kind: "screenshot", surface: "web", label: "04-after-room-switch" },

    // Threaded reply — done last since it opens the thread view (a nice finale
    // that shows threads); the helper returns to the room afterwards.
    { kind: "message", actor: "hermia", text: "The course of true love never did run smooth.",
      caption: "Cross-platform delivery continues seamlessly" },
    { kind: "reply", actor: "hermia", targetText: "true love never did run", text: "I would my father look'd but with my eyes.",
      caption: "Open a threaded reply on a message" },
    { kind: "screenshot", surface: "web", label: "05-reply-thread" },

    { kind: "wait", ms: 2000 },
    { kind: "screenshot", surface: "both", label: "06-final" },
  ],
};
