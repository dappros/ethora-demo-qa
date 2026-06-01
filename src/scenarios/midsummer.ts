import type { Scenario } from "./types.js";

/**
 * "A Midsummer Night's Dream" — the reference scenario.
 *
 * A lively group chat in The Forest Near Athens. Two lovers are driven live:
 * Hermia on the web component, Lysander on the iOS React Native component.
 * The fairies (Oberon, Titania, Puck) and the other Athenians seed the
 * backstory and chime in over XMPP so the room feels populated.
 *
 * Every line is from (or lightly adapted from) the play, so the transcript
 * reads beautifully in a marketing screenshot while exercising real features.
 */
export const midsummer: Scenario = {
  id: "midsummer",
  title: "A Midsummer Night's Dream",
  theme: "Shakespeare — the lovers and fairies in the forest near Athens",
  roomTitle: "The Forest Near Athens",

  cast: [
    { handle: "oberon", firstName: "Oberon", lastName: "Fairy-King", role: "King of the Fairies", avatarSeed: "Oberon", avatarColor: "#3b2e5a" },
    { handle: "titania", firstName: "Titania", lastName: "Fairy-Queen", role: "Queen of the Fairies", avatarSeed: "Titania", avatarColor: "#1f6f54" },
    { handle: "puck", firstName: "Puck", lastName: "Goodfellow", role: "A mischievous sprite", avatarSeed: "Puck", avatarColor: "#b5532a" },
    { handle: "hermia", firstName: "Hermia", lastName: "of-Athens", role: "In love with Lysander", avatarSeed: "Hermia", avatarColor: "#8a2d4a" },
    { handle: "lysander", firstName: "Lysander", lastName: "of-Athens", role: "In love with Hermia", avatarSeed: "Lysander", avatarColor: "#2a5d8a" },
    { handle: "helena", firstName: "Helena", lastName: "of-Athens", role: "In love with Demetrius", avatarSeed: "Helena", avatarColor: "#7a6a1f" },
    { handle: "demetrius", firstName: "Demetrius", lastName: "of-Athens", role: "Betrothed to Hermia", avatarSeed: "Demetrius", avatarColor: "#444c54" },
  ],

  heroes: {
    web: "hermia",
    ios: "lysander",
  },

  history: [
    { actor: "oberon", text: "Ill met by moonlight, proud Titania." },
    { actor: "titania", text: "What, jealous Oberon! Fairies, skip hence." },
    { actor: "puck", text: "I'll put a girdle round about the earth in forty minutes." },
    { actor: "helena", text: "Love looks not with the eyes, but with the mind." },
    { actor: "demetrius", text: "I love thee not, therefore pursue me not." },
  ],

  script: [
    { kind: "screenshot", surface: "both", label: "00-room-open", note: "Both clients joined; backstory history visible." },
    { kind: "wait", ms: 2500, note: "Hold on the opening shot — same room, both clients." },

    // Lysander (mobile) opens the live exchange.
    { kind: "message", actor: "lysander", text: "The course of true love never did run smooth.",
      caption: "Mobile (iOS) sends a message" },
    { kind: "screenshot", surface: "web", label: "01-web-receives-lysander", note: "Web shows Lysander's message arriving from the mobile client." },

    // Hermia (web) shows a typing indicator on the mobile side.
    { kind: "typing", actor: "hermia", ms: 3000,
      caption: "Web user is typing, iOS shows the indicator" },
    { kind: "screenshot", surface: "ios", label: "02-ios-sees-typing", note: "iOS shows Hermia typing." },

    { kind: "message", actor: "hermia", text: "I would my father look'd but with my eyes.",
      caption: "Web sends a reply, it appears on iOS" },
    { kind: "screenshot", surface: "ios", label: "03-ios-receives-hermia", note: "Mobile receives Hermia's reply from the web client." },

    // Media from the web hero.
    { kind: "media", actor: "hermia", asset: "moonlit-forest.png",
      caption: "Web sends an image, it renders on iOS" },
    { kind: "screenshot", surface: "web", label: "04-web-media-sent" },
    { kind: "screenshot", surface: "ios", label: "05-ios-media-received", note: "Image rendered on mobile." },

    // A fairy chimes in so the group feels alive.
    { kind: "message", actor: "puck", text: "Lord, what fools these mortals be!",
      caption: "A third participant joins the group chat" },
    { kind: "screenshot", surface: "both", label: "06-puck-groupchat", note: "Third participant lands on both clients." },

    // Edit + delete on the web hero.
    { kind: "message", actor: "hermia", text: "And yet, to say the truth, reason and love keep little compay.",
      caption: "Web sends a message with a typo" },
    { kind: "edit", actor: "hermia", targetText: "keep little compay", newText: "And yet, to say the truth, reason and love keep little company.",
      caption: "Editing the message, the edit syncs to iOS" },
    { kind: "screenshot", surface: "web", label: "07-web-message-edited" },
    { kind: "screenshot", surface: "ios", label: "08-ios-sees-edit", note: "Edit propagates to mobile." },

    { kind: "message", actor: "hermia", text: "(this line is a mistake)",
      caption: "Sending a message, then deleting it" },
    { kind: "delete", actor: "hermia", targetText: "(this line is a mistake)",
      caption: "Message deleted, removed on both clients" },
    { kind: "screenshot", surface: "web", label: "09-web-message-deleted" },

    // History / scrollback on the web hero.
    { kind: "history", actor: "hermia",
      caption: "Loading older message history (scrollback)" },
    { kind: "screenshot", surface: "web", label: "10-web-history-scrollback" },

    // Closing line from the mobile hero; demonstrate read receipts.
    { kind: "message", actor: "lysander", text: "Sleep give thee all his rest!",
      caption: "iOS sends the closing line, web shows read receipts" },
    { kind: "wait", ms: 2500 },
    { kind: "screenshot", surface: "ios", label: "11-ios-read-receipt", note: "Read ticks after web client views the message." },
    { kind: "screenshot", surface: "both", label: "12-final", note: "Final state of both clients." },
  ],
};
