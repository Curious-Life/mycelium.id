import type { Env } from "../types/env";

interface StreamUploadResponse {
  success: boolean;
  result?: {
    uid: string;
    thumbnail: string;
    playback: {
      hls: string;
      dash: string;
    };
    status: {
      state: string;
    };
    meta?: {
      name?: string;
    };
    duration?: number;
    size?: number;
  };
  errors?: Array<{ message: string }>;
}

interface StreamVideoInfo {
  uid: string;
  hlsUrl: string;
  dashUrl: string;
  thumbnailUrl: string;
  status: string;
  duration?: number;
}

/**
 * Cloudflare Stream service for video transcoding and delivery
 * Provides iOS-compatible HLS streaming
 */
export class StreamService {
  private accountId: string;
  private apiToken: string;
  private baseUrl: string;

  constructor(env: Env) {
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STREAM_TOKEN) {
      throw new Error("Cloudflare Stream credentials not configured");
    }
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID;
    this.apiToken = env.CLOUDFLARE_STREAM_TOKEN;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`;
  }

  /**
   * Check if Stream is configured
   */
  static isConfigured(env: Env): boolean {
    return !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_STREAM_TOKEN);
  }

  /**
   * Upload a video to Cloudflare Stream
   * Returns the video UID for playback
   */
  async uploadVideo(
    videoData: ArrayBuffer,
    filename: string,
    mimeType: string = "video/mp4"
  ): Promise<StreamVideoInfo> {
    // Create form data with the video file
    const formData = new FormData();
    const blob = new Blob([videoData], { type: mimeType });
    formData.append("file", blob, filename);

    // Require signed URLs for security - videos only playable with valid tokens
    formData.append("requireSignedURLs", "true");

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stream upload failed: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as StreamUploadResponse;

    if (!data.success || !data.result) {
      const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Unknown error";
      throw new Error(`Stream upload failed: ${errorMsg}`);
    }

    const result = data.result;

    return {
      uid: result.uid,
      hlsUrl: result.playback.hls,
      dashUrl: result.playback.dash,
      thumbnailUrl: result.thumbnail,
      status: result.status.state,
      duration: result.duration,
    };
  }

  /**
   * Get video info by UID
   */
  async getVideoInfo(uid: string): Promise<StreamVideoInfo | null> {
    const response = await fetch(`${this.baseUrl}/${uid}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to get video info: ${response.status}`);
    }

    const data = (await response.json()) as StreamUploadResponse;

    if (!data.success || !data.result) {
      return null;
    }

    const result = data.result;

    return {
      uid: result.uid,
      hlsUrl: result.playback.hls,
      dashUrl: result.playback.dash,
      thumbnailUrl: result.thumbnail,
      status: result.status.state,
      duration: result.duration,
    };
  }

  /**
   * Delete a video from Stream
   */
  async deleteVideo(uid: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/${uid}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    return response.ok;
  }

  /**
   * Get the HLS manifest URL for a video
   * This URL works on all devices including iOS Safari
   */
  static getHlsUrl(uid: string): string {
    // Format: https://customer-{code}.cloudflarestream.com/{uid}/manifest/video.m3u8
    // The actual customer code is returned in the playback.hls field from the API
    // For now, we use the iframe embed which works universally
    return `https://customer-${uid.substring(0, 8)}.cloudflarestream.com/${uid}/manifest/video.m3u8`;
  }

  /**
   * Get the iframe embed URL for a video
   */
  static getEmbedUrl(uid: string): string {
    return `https://customer-${uid.substring(0, 8)}.cloudflarestream.com/${uid}/iframe`;
  }

  /**
   * Get the thumbnail URL for a video
   */
  static getThumbnailUrl(uid: string): string {
    return `https://customer-${uid.substring(0, 8)}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`;
  }

  /**
   * Update video settings (e.g., enable requireSignedURLs for existing videos)
   */
  async updateVideoSettings(uid: string, settings: { requireSignedURLs?: boolean }): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${uid}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update video settings: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Generate a signed playback token for a video
   * This allows secure playback without making the video public
   * @param uid - The video UID
   * @param expiresInSeconds - Token expiration time (default 1 hour)
   */
  async generateSignedToken(uid: string, expiresInSeconds: number = 3600): Promise<string> {
    const response = await fetch(`${this.baseUrl}/${uid}/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate Stream token: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: { token: string };
      errors?: Array<{ message: string }>;
    };

    if (!data.success || !data.result?.token) {
      const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Unknown error";
      throw new Error(`Failed to generate Stream token: ${errorMsg}`);
    }

    return data.result.token;
  }

  /**
   * Get a signed HLS URL for playback
   * The token is appended to the URL for authenticated access
   */
  static getSignedHlsUrl(uid: string, token: string): string {
    return `https://videodelivery.net/${token}/manifest/video.m3u8`;
  }

  /**
   * Get a signed iframe embed URL
   */
  static getSignedEmbedUrl(uid: string, token: string): string {
    return `https://iframe.videodelivery.net/${token}`;
  }

  /**
   * Get a signed thumbnail URL
   */
  static getSignedThumbnailUrl(uid: string, token: string): string {
    return `https://videodelivery.net/${token}/thumbnails/thumbnail.jpg`;
  }

  /**
   * Create a direct upload URL for client-side uploads
   * This allows clients to upload directly to Stream without going through the Worker
   * Supports files up to 200GB (vs 100MB through Worker)
   *
   * @param maxDurationSeconds - Maximum allowed video duration (default 1800 = 30 min)
   * @param expirySeconds - How long the upload URL is valid (default 3600 = 1 hour)
   * @returns Direct upload URL and video UID
   */
  async createDirectUpload(
    maxDurationSeconds: number = 1800,
    expirySeconds: number = 3600
  ): Promise<{ uploadUrl: string; uid: string }> {
    const expiry = new Date(Date.now() + expirySeconds * 1000).toISOString();

    const response = await fetch(`${this.baseUrl}/direct_upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        maxDurationSeconds,
        expiry,
        requireSignedURLs: true, // Require signed URLs for playback
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create direct upload: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      result?: {
        uploadURL: string;
        uid: string;
      };
      errors?: Array<{ message: string }>;
    };

    if (!data.success || !data.result) {
      const errorMsg = data.errors?.map((e) => e.message).join(", ") || "Unknown error";
      throw new Error(`Failed to create direct upload: ${errorMsg}`);
    }

    return {
      uploadUrl: data.result.uploadURL,
      uid: data.result.uid,
    };
  }

  /**
   * Get video info including processing status
   * Used to check if a direct upload has been processed
   */
  async getVideoStatus(uid: string): Promise<{
    ready: boolean;
    status: string;
    duration?: number;
    size?: number;
  } | null> {
    const info = await this.getVideoInfo(uid);
    if (!info) return null;

    return {
      ready: info.status === "ready",
      status: info.status,
      duration: info.duration,
    };
  }
}
