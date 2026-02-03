/**
 * FavouriteAnything — Kettu / Bunny Plugin
 *
 * Adds a "⭐ Favourite" button to the long-press message ActionSheet
 * whenever the message contains an image or video (attachment or embed).
 * Tapping it calls Discord's own internal favourites API (the same one
 * the GIF picker uses), so the image/video shows up in your real
 * Discord Favourites tab — no separate local storage needed.
 *
 * Original Vencord plugin by: nin0 (Devs.nin0dev), Davri (457579346282938368)
 * Original license: GPL-3.0-or-later
 * Ported for Kettu/Bunny by: [Your Name]
 */

import { findByProps } from "@vendetta/metro";

// ---------------------------------------------------------------------------
// Lazy module cache — resolved once on first use, then reused
// ---------------------------------------------------------------------------
let _favouritesAPI  = null;   // { addToFavorites, removeFromFavorites }
let _messageActions = null;   // module whose action-builder we patch

/**
 * Discord's internal favourites API.
 * Same one the GIF picker calls.  We find it by two props that have
 * been stable across many Discord builds.
 */
function getFavouritesAPI() {
    if (_favouritesAPI) return _favouritesAPI;
    try {
        _favouritesAPI = findByProps("addToFavorites", "removeFromFavorites");
    } catch (e) {
        console.warn("[FavouriteAnything] Could not find favourites API:", e);
    }
    return _favouritesAPI;
}

/**
 * The module that builds the options array shown in the long-press
 * ActionSheet.  We locate it by two action-key strings that Discord
 * always includes: "markAsUnread" and "suppressEmbeds".
 *
 * If Discord ever renames these internally, update the strings here.
 */
function getMessageActionsModule() {
    if (_messageActions) return _messageActions;
    try {
        _messageActions = findByProps("markAsUnread", "suppressEmbeds");
    } catch (e) {
        console.warn("[FavouriteAnything] Could not find MessageActions module:", e);
    }
    return _messageActions;
}

// ---------------------------------------------------------------------------
// Helpers — pull image / video info out of a Discord message object
// ---------------------------------------------------------------------------

/** Format values matching Discord's internal enum */
const Format = { IMAGE: 1, VIDEO: 2 };

/**
 * Walk a message's attachments and embeds and return the first
 * image or video found, or null.
 *
 * @param {object} message   raw Discord message
 * @returns {{ url, proxyURL, width, height, isVideo } | null}
 */
function extractMedia(message) {
    if (!message) return null;

    // --- Attachments (files the user uploaded directly) ---
    if (Array.isArray(message.attachments)) {
        for (const att of message.attachments) {
            const ct = (att.content_type || "").split(";")[0];
            if (ct.startsWith("image/") || ct.startsWith("video/")) {
                return {
                    url:     att.url,
                    proxyURL: att.proxy_url || att.url,
                    width:   att.width  || 0,
                    height:  att.height || 0,
                    isVideo: ct.startsWith("video/")
                };
            }
        }
    }

    // --- Embeds (rich previews / gifv / image or video embeds) ---
    if (Array.isArray(message.embeds)) {
        for (const embed of message.embeds) {
            // gifv (tenor, giphy …)
            if (embed.type === "gifv" && embed.video) {
                return {
                    url:     embed.url || embed.video.url,
                    proxyURL: embed.video.proxy_url || embed.video.url || embed.url,
                    width:   embed.video.width  || 0,
                    height:  embed.video.height || 0,
                    isVideo: true
                };
            }
            if (embed.video) {
                return {
                    url:     embed.video.url,
                    proxyURL: embed.video.proxy_url || embed.video.url,
                    width:   embed.video.width  || 0,
                    height:  embed.video.height || 0,
                    isVideo: true
                };
            }
            if (embed.image) {
                return {
                    url:     embed.image.url,
                    proxyURL: embed.image.proxy_url || embed.image.url,
                    width:   embed.image.width  || 0,
                    height:  embed.image.height || 0,
                    isVideo: false
                };
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// The action-item object we push into the ActionSheet options array
// ---------------------------------------------------------------------------

/**
 * @param {object} media  output of extractMedia()
 */
function buildFavouriteAction(media) {
    return {
        key:   "favouriteAnything",          // unique key so React doesn't complain
        label: "⭐ Favourite",
        onPress: () => {
            const api = getFavouritesAPI();
            if (api && typeof api.addToFavorites === "function") {
                try {
                    api.addToFavorites({
                        src:    media.proxyURL,
                        url:    media.url,
                        width:  media.width,
                        height: media.height,
                        format: media.isVideo ? Format.VIDEO : Format.IMAGE
                    });
                    
                    // Show toast notification
                    const { showToast } = findByProps("showToast") || {};
                    if (showToast) {
                        showToast("Added to Favourites ⭐", 1);
                    }
                } catch (e) {
                    console.error("[FavouriteAnything] addToFavorites threw:", e);
                    const { showToast } = findByProps("showToast") || {};
                    if (showToast) {
                        showToast("Failed to favourite — check console.", 2);
                    }
                }
            } else {
                const { showToast } = findByProps("showToast") || {};
                if (showToast) {
                    showToast("Favourites API unavailable on this Discord build.", 2);
                }
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Core patch — hooks into the message-actions builder
// ---------------------------------------------------------------------------

let unpatch = null;   // cleanup handle from patcher.after

/**
 * patcher.after signature:  (methodName, object, callback)
 *   callback(args, returnValue)  — args = original call args, returnValue = what the
 *                                  original function returned.
 *
 * Discord mobile builds the long-press sheet in one of two ways:
 *   A) A function that returns the options array directly.
 *   B) A render function returning a React element that contains the array
 *      somewhere in its props tree.
 * We handle both.
 */
function applyPatch() {
    const mod = getMessageActionsModule();
    if (!mod) {
        console.error(
            "[FavouriteAnything] MessageActions module not found yet. " +
            "Long-press any message once, then re-enable the plugin."
        );
        return;
    }

    // Get patcher from global bunny object
    const { patcher } = window.bunny || {};
    if (!patcher) {
        console.error("[FavouriteAnything] Patcher not available!");
        return;
    }

    // Resolve which exported function to patch.
    // Try the most common named exports first, fall back to default.
    const candidates = ["getActions", "buildActions", "default"];
    let patchKey    = null;

    for (const name of candidates) {
        if (typeof mod[name] === "function") {
            patchKey = name;
            break;
        }
    }

    if (!patchKey) {
        console.error(
            "[FavouriteAnything] No patchable function found on MessageActions. " +
            "Available keys:",
            Object.keys(mod)
        );
        return;
    }

    unpatch = patcher.after(patchKey, mod, function afterActions(args, ret) {
        // ---------------------------------------------------------------
        // 1. Pull the message object out of the arguments.
        //    Shapes seen in the wild:
        //      (message)            → args[0] is the message directly
        //      ({ message, … })     → args[0].message
        // ---------------------------------------------------------------
        const message =
            (args[0] && args[0].message) ||
            args[0] ||
            null;

        const media = extractMedia(message);
        if (!media) return ret;   // nothing to favourite, don't touch the sheet

        // ---------------------------------------------------------------
        // 2. Inject our action into the options array.
        // ---------------------------------------------------------------

        // --- Shape A: ret IS the options array ---
        if (Array.isArray(ret)) {
            ret.push(buildFavouriteAction(media));
            return ret;
        }

        // --- Shape B: ret is a React element; options lives in props ---
        if (ret && ret.props) {
            // Direct child: ret.props.options
            if (Array.isArray(ret.props.options)) {
                ret.props.options.push(buildFavouriteAction(media));
                return ret;
            }
            // One level deeper (common wrapper pattern)
            if (Array.isArray(ret.props.children)) {
                for (const child of ret.props.children) {
                    if (child && child.props && Array.isArray(child.props.options)) {
                        child.props.options.push(buildFavouriteAction(media));
                        return ret;
                    }
                }
            }
        }

        // Could not find the array — log for debugging but don't crash
        console.warn(
            "[FavouriteAnything] Could not locate options array. " +
            "Return-value shape:",
            ret
        );
        return ret;
    });
}

// ---------------------------------------------------------------------------
// Plugin definition  (Vendetta / Bunny / Kettu standard export)
// ---------------------------------------------------------------------------
export default {
    onLoad: () => {
        applyPatch();
        console.log("[FavouriteAnything] Enabled");
    },

    onUnload: () => {
        if (typeof unpatch === "function") {
            unpatch();
            unpatch = null;
        }
        // Clear caches so a fresh enable re-resolves modules
        _favouritesAPI  = null;
        _messageActions = null;
        console.log("[FavouriteAnything] Disabled");
    }
};
