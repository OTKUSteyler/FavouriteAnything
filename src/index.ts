/**
 * FavouriteAnything — Kettu / Bunny Plugin
 *
 * Adds a "⭐ Favourite" option to the long-press message action sheet
 * whenever the held message contains an image or video attachment / embed.
 *
 * Original Vencord plugin by nin0 & Davri (GPL-3.0-or-later)
 * Ported to Kettu by: [Your Name]
 *
 * --------------------------------------------------------------------------
 * HOW IT WORKS
 * --------------------------------------------------------------------------
 * When you long-press a message on Discord mobile, Discord builds an array
 * of action-sheet items by calling an internal function (commonly exposed via
 * a module that owns "getMessageActions" or "MessageActions").
 *
 * This plugin uses patcher.after() on that function.  The "after" hook runs
 * AFTER the original returns, so we still get every default menu item.  We
 * then inspect the message for image/video content and, if found, push our
 * own action item onto the end of the array.
 *
 * Pressing "⭐ Favourite" calls Discord's own internal GIF-favourites API
 * (the same one the native "Add to favourites" GIF button uses).  If that
 * API isn't reachable at runtime the plugin falls back to downloading the
 * image via the standard share / save flow.
 * --------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Kettu / Bunny runtime imports
// ---------------------------------------------------------------------------
// Adjust these paths if your specific Kettu build uses different module names.
// Common alternatives:  "@bunny/modules"  /  "@vendetta/metro-modules"
const {
  findByProps,
  findByDisplayName,
} = require("@vendetta/metro-modules");

const { patcher } = require("@vendetta/patcher");

// React Native built-ins — always available inside the Discord bundle
const { Share, ToastAndroid, Platform } = require("react-native");

// ---------------------------------------------------------------------------
// Helpers – locate Discord internals
// ---------------------------------------------------------------------------

/**
 * Returns the module that owns the message-actions array builder.
 *
 * Discord's minified bundle changes frequently, so we try several known
 * property signatures.  The first one that resolves wins.  If none match
 * you'll need to use the ActionSheetFinder dev plugin to locate the current
 * key at runtime.
 *
 * Known candidates (as of late 2024 / early 2025 builds):
 *   "getMessageActions"
 *   "messageActions"
 *   "buildMessageActions"
 */
function findMessageActionsModule() {
  const candidates = [
    "getMessageActions",
    "messageActions",
    "buildMessageActions",
    "MessageActions",
  ];

  for (const key of candidates) {
    try {
      const mod = findByProps(key);
      if (mod) return { module: mod, key };
    } catch (_) {
      // findByProps throws when nothing matches — keep trying
    }
  }
  return null;
}

/**
 * Locate Discord's internal GIF / media favourites utility.
 * It typically lives on a module that also exports "addToFavorites".
 */
function findFavoritesModule() {
  try {
    return findByProps("addToFavorites");
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image / video extraction
// ---------------------------------------------------------------------------

/**
 * Pull every image or video URL out of a Discord message object.
 *
 * A message can contain media in two places:
 *   1. message.attachments  – files the user uploaded directly
 *   2. message.embeds       – rich-embed objects (link previews, gifv, etc.)
 *
 * We return an array of  { url, proxyUrl, isVideo }  descriptors so the
 * action handler knows what to favourite / download.
 */
function extractMedia(message) {
  const media = [];

  // --- attachments (direct uploads) ----------------------------------------
  if (Array.isArray(message?.attachments)) {
    for (const att of message.attachments) {
      const contentType = (att.content_type || att.contentType || "").toLowerCase();
      if (contentType.startsWith("image/")) {
        media.push({
          url: att.url,
          proxyUrl: att.proxy_url || att.proxyURL || att.url,
          isVideo: false,
        });
      } else if (contentType.startsWith("video/")) {
        media.push({
          url: att.url,
          proxyUrl: att.proxy_url || att.proxyURL || att.url,
          isVideo: true,
        });
      }
    }
  }

  // --- embeds (link-previews / gifv / rich) ----------------------------------
  if (Array.isArray(message?.embeds)) {
    for (const embed of message.embeds) {
      // gifv embeds  (e.g. Tenor / Giphy)
      if (embed.type === "gifv" && embed.video) {
        media.push({
          url: embed.url || embed.video.url,
          proxyUrl: embed.video.proxy_url || embed.video.proxyURL || embed.video.url,
          isVideo: true,
        });
      }
      // rich / link embeds that carry an image
      if (embed.image) {
        media.push({
          url: embed.image.url,
          proxyUrl: embed.image.proxy_url || embed.image.proxyURL || embed.image.url,
          isVideo: false,
        });
      }
      // video embeds without gifv type
      if (embed.video && embed.type !== "gifv") {
        media.push({
          url: embed.video.url,
          proxyUrl: embed.video.proxy_url || embed.video.proxyURL || embed.video.url,
          isVideo: true,
        });
      }
    }
  }

  return media;
}

// ---------------------------------------------------------------------------
// Favourite action handler
// ---------------------------------------------------------------------------

/**
 * Attempt to favourite the first media item found.
 *
 * Priority:
 *   1. Discord's internal addToFavorites  (mirrors the native GIF ⭐ button)
 *   2. Native Share sheet                 (fallback — lets the user save it)
 */
async function favouriteMedia(mediaList) {
  if (!mediaList || mediaList.length === 0) return;

  const target = mediaList[0]; // favourite the first / most prominent media

  // --- try Discord's own favourites API ------------------------------------
  const favMod = findFavoritesModule();
  if (favMod && typeof favMod.addToFavorites === "function") {
    try {
      favMod.addToFavorites({
        src: target.proxyUrl || target.url,
        url: target.url,
        format: target.isVideo ? 2 : 1, // VIDEO = 2, IMAGE = 1
      });
      showToast("Added to favourites ⭐");
      return;
    } catch (e) {
      console.warn("[FavouriteAnything] addToFavorites threw:", e);
      // fall through to share-sheet fallback
    }
  }

  // --- fallback: open the native Share sheet with the URL -------------------
  try {
    await Share.open({
      message: target.url,
      title: "Save media",
    });
  } catch (e) {
    // User cancelled or share failed — show nothing
    console.warn("[FavouriteAnything] Share.open cancelled or failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Toast helper (cross-platform)
// ---------------------------------------------------------------------------
function showToast(message) {
  if (Platform.OS === "android") {
    ToastAndroid.showWithGravity(message, ToastAndroid.SHORT, ToastAndroid.BOTTOM);
  }
  // iOS: no built-in Toast.  You could swap this for a 3rd-party toast lib
  // or just rely on the silent success of addToFavorites.
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

let cleanups = [];

module.exports = {
  name: "FavouriteAnything",
  description: "Adds a ⭐ Favourite button to the long-press menu on any message containing an image or video",
  authors: [
    { name: "nin0" },                          // original Vencord author
    { name: "Davri", id: 457579346282938368n }, // original Vencord author
  ],

  onEnable() {
    // ------------------------------------------------------------------
    // 1. Locate the message-actions module
    // ------------------------------------------------------------------
    const found = findMessageActionsModule();
    if (!found) {
      console.error(
        "[FavouriteAnything] Could not find the message-actions module.\n" +
        "Install the 'ActionSheetFinder' dev plugin, long-press a message,\n" +
        "and check the log to discover the current module key — then update\n" +
        "the candidates list in findMessageActionsModule()."
      );
      return;
    }

    const { module: actionsModule, key: actionsKey } = found;
    console.log("[FavouriteAnything] Patching module key:", actionsKey);

    // ------------------------------------------------------------------
    // 2. patcher.after — runs after the original function, receives its
    //    return value so we can append our item without breaking anything.
    //
    //    The original function signature is roughly:
    //      getMessageActions(message, channel, ...) => ActionItem[]
    //
    //    Each ActionItem looks like:
    //      { label: string, icon?: any, onPress: () => void }
    //    (exact shape varies by Discord version)
    // ------------------------------------------------------------------
    const unpatch = patcher.after(actionsKey, actionsModule, function (args, result) {
      // args[0] is typically the message object
      const message = args[0];

      // Extract image / video content from the message
      const media = extractMedia(message);
      if (media.length === 0) {
        // No visual media — don't pollute the menu
        return result;
      }

      // Build our action item in the same shape Discord uses
      const favouriteAction = {
        label: "⭐ Favourite",
        // icon: you can set this to a require()'d icon asset if you have one,
        //        or leave it undefined — Discord will render label-only.
        onPress: () => favouriteMedia(media),
      };

      // `result` might be an array directly, or an object with an `items`
      // array depending on the Discord version.  Handle both.
      if (Array.isArray(result)) {
        result.push(favouriteAction);
      } else if (result && Array.isArray(result.items)) {
        result.items.push(favouriteAction);
      } else if (result && Array.isArray(result.actions)) {
        result.actions.push(favouriteAction);
      }

      return result;
    });

    cleanups.push(unpatch);
    console.log("[FavouriteAnything] Enabled ⭐");
  },

  onDisable() {
    cleanups.forEach((fn) => {
      try { fn(); } catch (e) { console.warn("[FavouriteAnything] cleanup error:", e); }
    });
    cleanups = [];
    console.log("[FavouriteAnything] Disabled");
  },
};
