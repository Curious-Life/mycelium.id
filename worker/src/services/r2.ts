import type { Env } from "../types/env";

export class R2Service {
  private bucket: R2Bucket;

  constructor(env: Env) {
    this.bucket = env.BUCKET;
  }

  /**
   * Store a file in R2
   */
  async store(
    key: string,
    data: ArrayBuffer,
    metadata?: Record<string, string>
  ): Promise<void> {
    await this.bucket.put(key, data, {
      customMetadata: metadata,
    });
  }

  /**
   * Retrieve a file from R2
   */
  async get(key: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.arrayBuffer();
  }

  /**
   * Delete a file from R2
   */
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  /**
   * Check if a file exists
   */
  async exists(key: string): Promise<boolean> {
    const object = await this.bucket.head(key);
    return object !== null;
  }

  /**
   * Generate a unique key for an attachment
   * Uses crypto.getRandomValues() for cryptographically secure randomness
   */
  generateKey(
    userId: string,
    type: "voice" | "image" | "video" | "file",
    extension: string
  ): string {
    const timestamp = Date.now();
    // Generate 16 bytes (128 bits) of cryptographically secure randomness
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const random = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${userId}/${type}/${timestamp}-${random}.${extension}`;
  }

  /**
   * Store voice note and return key
   */
  async storeVoice(userId: string, data: ArrayBuffer): Promise<string> {
    const key = this.generateKey(userId, "voice", "ogg");
    await this.store(key, data, { type: "voice" });
    return key;
  }

  /**
   * Store image and return key
   */
  async storeImage(
    userId: string,
    data: ArrayBuffer,
    mimeType: string
  ): Promise<string> {
    const extension = mimeType.split("/")[1] || "jpg";
    const key = this.generateKey(userId, "image", extension);
    await this.store(key, data, { type: "image", mimeType });
    return key;
  }

  /**
   * Store video and return key
   */
  async storeVideo(
    userId: string,
    data: ArrayBuffer,
    mimeType: string,
    durationSeconds?: number
  ): Promise<string> {
    const extension = mimeType.split("/")[1] || "mp4";
    const key = this.generateKey(userId, "video", extension);
    await this.store(key, data, {
      type: "video",
      mimeType,
      ...(durationSeconds ? { duration: durationSeconds.toString() } : {}),
    });
    return key;
  }

  /**
   * Store generic file and return key
   */
  async storeFile(
    userId: string,
    data: ArrayBuffer,
    filename: string,
    mimeType: string
  ): Promise<string> {
    const extension = filename.split(".").pop() || "bin";
    const key = this.generateKey(userId, "file", extension);
    await this.store(key, data, {
      type: "file",
      originalFilename: filename,
      mimeType,
    });
    return key;
  }

  /**
   * Store an Obsidian vault attachment with path-preserving key
   * Key format: {userId}/obsidian/{vaultName}/{originalPath}
   */
  async storeObsidianAttachment(
    userId: string,
    vaultName: string,
    originalPath: string,
    data: ArrayBuffer,
    mimeType: string
  ): Promise<string> {
    // Sanitize vault name and path for use in key
    const sanitizedVault = vaultName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedPath = originalPath.replace(/\.\./g, '_');
    const key = `${userId}/obsidian/${sanitizedVault}/${sanitizedPath}`;

    await this.store(key, data, {
      type: "obsidian",
      originalPath,
      vaultName,
      mimeType,
    });
    return key;
  }
}
