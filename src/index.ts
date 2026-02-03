/**
 * FavouriteAnything - Kettu Plugin
 * Port of Vencord's FavouriteAnything by nin0 & Davri
 * Allows favouriting any image or video, not just GIFs.
 *
 * Original: https://github.com/Vendicated/Vencord
 * Original license: GPL-3.0-or-later
 * Original authors: nin0 (Devs.nin0dev), Davri (457579346282938368)
 *
 * Ported for Kettu (Bunny/Vendetta) by: [Your Name]
 */

const { registerPlugin } = require("@react-native-communities/async-storage") || {};
const {
  findByProps,
  findByDisplayName,
  findComponentByName,
  lazy,
} = require("@vendetta/metro-modules") || require("@bunny/modules") || {};
const { React } = require("react");
const { View, TouchableOpacity, Text, StyleSheet } = require("react-native");

// ---------------------------------------------------------------------------
// Helpers — safe lazy finders that won't crash if a module hasn't loaded yet
// ---------------------------------------------------------------------------

/**
 * Attempt to locate Discord's internal GIF/media favourite button component.
 * Discord's mobile client exposes this somewhere in its media overlay modules.
 * Adjust the search props/name if Discord updates its internals.
 */
function findFavoriteButtonComponent() {
  // Try by display name first (most stable across updates)
  let comp = null;
  try {
    comp = findComponentByName?.("GifFavoriteButton") || findByDisplayName?.("GifFavoriteButton");
  } catch {}
  if (comp) return comp;

  // Fallback: search by a known prop that the favourite button always receives
  try {
    comp = findByProps?.("gifFavoriteButton");
  } catch {}
  return comp;
}

/**
 * Try to locate the media overlay / GIF overlay module that controls
 * how image/video previews are rendered with their accessory overlays.
 */
function findMediaOverlayModule() {
  let mod = null;
  try {
    mod = findByProps?.("renderOverlayContent", "renderLinkComponent");
  } catch {}
  return mod;
}

/**
 * Try to locate the embed renderer module.
 * This is the component that renders rich embeds containing images/videos.
 */
function findEmbedModule() {
  let mod = null;
  try {
    mod = findByProps?.("SUPPRESS_ALL_EMBEDS");
  } catch {}
  if (!mod) {
    try {
      mod = findByDisplayName?.("Embed");
    } catch {}
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Format enum (mirrors Vencord's internal enum)
// ---------------------------------------------------------------------------
const Format = Object.freeze({
  NONE: 0,
  IMAGE: 1,
  VIDEO: 2,
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  favouriteButtonContainer: {
    position: "absolute",
    top: 4,
    right: 4,
    zIndex: 10,
  },
  favouriteButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  favouriteButtonText: {
    fontSize: 14,
    color: "#fff",
  },
});

// ---------------------------------------------------------------------------
// Accessory component — rendered on top of every image / video preview
// ---------------------------------------------------------------------------

/**
 * FavouriteAccessory
 *
 * Renders a star (☆ / ★) button overlay on images and videos so that
 * the user can favourite them regardless of file type.
 *
 * @param {{ url: string, proxyUrl?: string, width: number, height: number, video?: boolean }} props
 */
function FavouriteAccessory({ url, proxyUrl, width, height, video }) {
  const [favourited, setFavourited] = React.useState(false);

  if (!url || !width || !height) return null;

  /**
   * Attempt to call Discord's native favouriting API.
   * If it isn't available we fall back to a no-op so the button still
   * renders (useful for development / future API changes).
   */
  const handlePress = React.useCallback(() => {
    const FavouriteButton = findFavoriteButtonComponent();

    if (FavouriteButton && FavouriteButton.addToFavorites) {
      // Discord's internal method — signature may vary across versions
      try {
        FavouriteButton.addToFavorites({
          src: proxyUrl || url,
          url: url,
          format: video ? Format.VIDEO : Format.IMAGE,
          width,
          height,
        });
      } catch (e) {
        console.warn("[FavouriteAnything] addToFavorites failed:", e);
      }
    }

    // Toggle local visual state regardless so the user gets feedback
    setFavourited((prev) => !prev);
  }, [url, proxyUrl, width, height, video]);

  return (
    <View style={styles.favouriteButtonContainer}>
      <TouchableOpacity
        style={styles.favouriteButton}
        onPress={handlePress}
        activeOpacity={0.6}
        accessibilityLabel={favourited ? "Remove from favourites" : "Add to favourites"}
      >
        <Text style={styles.favouriteButtonText}>
          {favourited ? "★" : "☆"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

/**
 * Patches a media-overlay or embed component so that our accessory is
 * injected into its render output.
 *
 * @param {object} patcher   — the Vendetta/Bunny patcher instance
 * @param {Function} target  — the original component / render function
 * @returns {Function|null}  — cleanup function, or null if patching failed
 */
function patchMediaComponent(patcher, target) {
  if (!target || !patcher) return null;

  // patcher.after wraps the original so it still runs, then we augment the result
  return patcher.after(target, function afterMediaRender(args, result) {
    // `result` is the React element tree returned by the original render.
    // We need to wrap it in a <View> and overlay our favourite button.

    // --- Extract useful props from the original component's arguments ---
    // Discord's media overlay typically passes props as the first argument.
    const props = args[0] || {};
    const src = props.src || props.proxyURL || props.url || "";
    const url = props.url || src;
    const width = props.width || 0;
    const height = props.height || 0;
    const isVideo = !!props.video || !!props.isVideo;

    if (!src && !url) return result; // nothing to favourite

    return (
      <View style={{ flex: 1 }}>
        {result}
        <FavouriteAccessory
          url={url}
          proxyUrl={src}
          width={width}
          height={height}
          video={isVideo}
        />
      </View>
    );
  });
}

/**
 * Patches the embed renderer so that image / video embeds also receive
 * the favourite overlay.
 *
 * @param {object} patcher
 * @param {object} embedModule — the module that owns embed rendering
 * @returns {Function|null}
 */
function patchEmbedRenderer(patcher, embedModule) {
  if (!embedModule || !patcher) return null;

  const renderTarget = embedModule.render || embedModule.default?.render;
  if (!renderTarget) return null;

  return patcher.after(renderTarget, function afterEmbedRender(args, result) {
    const embed = args[0]?.embed || args[0] || {};
    const content = embed.image || embed.video;
    if (!content) return result;

    const url =
      (embed.type === "gifv" && embed.url) || content.url || "";
    const proxyUrl = content.proxyURL || url;
    const width = content.width || 0;
    const height = content.height || 0;
    const isVideo = !!embed.video;

    if (!url || !width || !height) return result;

    return (
      <View style={{ flex: 1 }}>
        {result}
        <FavouriteAccessory
          url={url}
          proxyUrl={proxyUrl}
          width={width}
          height={height}
          video={isVideo}
        />
      </View>
    );
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

// We keep references to every cleanup handle so onDisable can undo everything.
let cleanups = [];

module.exports = {
  name: "FavouriteAnything",
  description: "Favourite any image or video, not just GIFs",
  authors: [
    { name: "nin0", id: 0n },          // original Vencord author
    { name: "Davri", id: 457579346282938368n }, // original Vencord author
  ],

  /**
   * onEnable — called when the user toggles the plugin on (or on app start
   * if it was already enabled).  We locate the relevant Discord modules and
   * apply our monkey-patches via the Vendetta/Bunny patcher.
   */
  onEnable() {
    // Obtain the patcher from the Vendetta / Bunny / Kettu runtime.
    // The exact import path depends on your loader — adjust if needed.
    let patcher;
    try {
      patcher = require("@vendetta/patcher") || require("@bunny/patcher");
    } catch {
      console.error(
        "[FavouriteAnything] Could not load patcher — " +
        "make sure your Kettu / Bunny loader supports it."
      );
      return;
    }

    // ----- 1. Patch the media overlay (handles standalone image/video previews) -----
    const mediaOverlay = findMediaOverlayModule();
    if (mediaOverlay) {
      const target =
        mediaOverlay.renderOverlayContent ||
        mediaOverlay.default?.renderOverlayContent;

      const cleanup = patchMediaComponent(patcher, target);
      if (cleanup) cleanups.push(cleanup);
    } else {
      console.warn(
        "[FavouriteAnything] Media overlay module not found — " +
        "standalone image favouriting may not work."
      );
    }

    // ----- 2. Patch the embed renderer (handles image/video inside rich embeds) -----
    const embedMod = findEmbedModule();
    if (embedMod) {
      const cleanup = patchEmbedRenderer(patcher, embedMod);
      if (cleanup) cleanups.push(cleanup);
    } else {
      console.warn(
        "[FavouriteAnything] Embed module not found — " +
        "embed image/video favouriting may not work."
      );
    }

    console.log("[FavouriteAnything] Enabled ★");
  },

  /**
   * onDisable — called when the user toggles the plugin off or the app shuts
   * down.  We run every cleanup handle returned by patcher.after so that
   * Discord's original behaviour is fully restored.
   */
  onDisable() {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.warn("[FavouriteAnything] Cleanup error:", e);
      }
    });
    cleanups = [];
    console.log("[FavouriteAnything] Disabled");
  },
};
