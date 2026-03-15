import { ApiResponse, Innertube } from "youtubei.js";
import NavigationEndpoint from "youtubei.js/NavigationEndpoint";
import type { TokenMinter } from "../jobs/potoken.ts";

import type { Config } from "./config.ts";

function callWatchEndpoint(
    videoId: string,
    innertubeClient: Innertube,
    innertubeClientType: string,
    contentPoToken: string,
) {
    const watch_endpoint = new NavigationEndpoint({
        watchEndpoint: {
            videoId: videoId,
            racyCheckOk: true,
            contentCheckOk: true,
        },
    });

    return watch_endpoint.call(
        innertubeClient.actions,
        {
            playbackContext: {
                contentPlaybackContext: {
                    vis: 0,
                    splay: false,
                    lactMilliseconds: "-1",
                    signatureTimestamp: innertubeClient.session.player
                        ?.signature_timestamp,
                },
            },
            serviceIntegrityDimensions: {
                poToken: contentPoToken,
            },
            client: innertubeClientType,
        },
    );
}

 
function isPlayerResponseValid(data: Record<string, any>): boolean {
    // 1. Must have playabilityStatus and it must indicate success.
    const playabilityStatus = data?.playabilityStatus?.status as
        | string
        | undefined;

    const PLAYABLE_STATUSES = new Set(["OK", "CONTENT_CHECK_REQUIRED"]);

    if (!playabilityStatus || !PLAYABLE_STATUSES.has(playabilityStatus)) {
        console.log(
            `[DEBUG] playabilityStatus = ${playabilityStatus ?? "(missing)"}`,
        );
        return false;
    }

    // 2. Must have streamingData.
    if (!data?.streamingData) {
        console.log("[DEBUG] streamingData is missing.");
        return false;
    }

    // 3. adaptiveFormats must be a non-empty array.
    const adaptiveFormats = data.streamingData.adaptiveFormats;
    if (!Array.isArray(adaptiveFormats) || adaptiveFormats.length === 0) {
        console.log("[DEBUG] adaptiveFormats is empty or missing.");
        return false;
    }

    // 4. The first format must carry either a plain URL or a signatureCipher.
    const firstFormat = adaptiveFormats[0];
    if (!firstFormat.url && !firstFormat.signatureCipher) {
        console.log(
            "[DEBUG] First adaptiveFormat has neither url nor signatureCipher.",
        );
        return false;
    }

    return true;
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;

    // When OAuth is active the TV client has full entitlements (age-gated,
    // made-for-kids, etc.).  Without OAuth we start with ANDROID_VR and fall
    // back as needed.
    const primaryClient = innertubeClientOauthEnabled ? "TV" : "ANDROID_VR";

    const contentPoToken = await tokenMinter(videoId);

    console.log(`[INFO] Trying primary YT client: ${primaryClient}`);
    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        primaryClient,
        contentPoToken,
    );

    // Fast-path: primary client returned a fully usable response.
    if (isPlayerResponseValid(youtubePlayerResponse.data)) {
        return youtubePlayerResponse;
    }

    console.log(
        `[WARNING] Primary client (${primaryClient}) returned an unusable ` +
            `response for video "${videoId}". Falling back to other YT clients.`,
    ); 
    const fallbackClients = ["TV_SIMPLY", "WEB", "MWEB"];

    for (const clientType of fallbackClients) {
        console.log(`[WARNING] Trying fallback YT client: ${clientType}`);

        let fallbackResponse: ApiResponse;
        try {
            fallbackResponse = await callWatchEndpoint(
                videoId,
                innertubeClient,
                clientType,
                contentPoToken,
            );
        } catch (err) {
            console.log(
                `[WARNING] Fallback client ${clientType} threw an error: ${err}`,
            );
            continue;
        }

        if (!isPlayerResponseValid(fallbackResponse.data)) {
            console.log(
                `[WARNING] Fallback client ${clientType} also returned an ` +
                    "unusable response. Continuing to next fallback.",
            );
            continue;
        }

        console.log(
            `[INFO] Fallback client ${clientType} returned a valid response.`,
        );

        // Graft the working streamingData onto the original response so that
        // all other metadata (videoDetails, microformat, etc.) from the first
        // request is preserved for callers that rely on it.
        youtubePlayerResponse.data.streamingData =
            fallbackResponse.data.streamingData;

        // Also propagate playabilityStatus so callers see "OK" rather than
        // whatever error the primary client returned.
        youtubePlayerResponse.data.playabilityStatus =
            fallbackResponse.data.playabilityStatus;

        return youtubePlayerResponse;
    }

    // All clients failed — return the original response as-is and let the
    // caller decide how to handle the error (it can inspect playabilityStatus).
    console.log(
        `[ERROR] All YT clients failed for video "${videoId}". ` +
            "Returning primary response with original error details.",
    );
    return youtubePlayerResponse;
};
