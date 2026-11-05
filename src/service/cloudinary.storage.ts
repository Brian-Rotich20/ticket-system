import path from 'node:path';
import type { StorageService } from './storage.service.js';

/** The slice of the Cloudinary v2 SDK we use (kept narrow so it can be faked in tests). */
export interface CloudinaryClient {
  url(publicId: string, options: Record<string, unknown>): string;
  uploader: {
    upload_stream(
      options: Record<string, unknown>,
      callback: (error: unknown, result?: { public_id: string }) => void,
    ): { end(data: Buffer): void };
    destroy(publicId: string, options: Record<string, unknown>): Promise<unknown>;
  };
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * Images are stored as Cloudinary `image` assets (public_id without the extension);
 * PDFs and logs are stored as `raw` assets (extension kept in the public_id).
 */
function describe(key: string, folder: string) {
  const ext = path.extname(key).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { resourceType: 'image' as const, publicId: `${folder}/${key.slice(0, -ext.length)}`, format: ext.slice(1) };
  }
  return { resourceType: 'raw' as const, publicId: `${folder}/${key}`, format: undefined };
}

/**
 * Cloudinary-backed attachment storage.
 *
 * Security model: every asset is uploaded with `type: 'authenticated'`, so Cloudinary refuses to serve it
 * without a signed URL. We never hand a Cloudinary URL to the client: the API checks ticket access first,
 * then fetches the file with a server-side signed URL and streams it back (AttachmentService.readFile).
 */
export class CloudinaryStorageService implements StorageService {
  constructor(
    private readonly cloudinary: CloudinaryClient,
    private readonly folder: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async save(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const d = describe(key, this.folder);
    await new Promise<void>((resolve, reject) => {
      const stream = this.cloudinary.uploader.upload_stream(
        {
          public_id: d.publicId,
          resource_type: d.resourceType,
          type: 'authenticated',
          overwrite: false,
          unique_filename: false,
          use_filename: false,
        },
        (error, result) => (error || !result ? reject(error ?? new Error('Cloudinary upload failed')) : resolve()),
      );
      stream.end(data);
    });
  }

  async read(key: string): Promise<Buffer> {
    const d = describe(key, this.folder);
    const url = this.cloudinary.url(d.publicId, {
      resource_type: d.resourceType,
      type: 'authenticated',
      sign_url: true,
      secure: true,
      ...(d.format ? { format: d.format } : {}),
    });
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Cloudinary download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const d = describe(key, this.folder);
    await this.cloudinary.uploader.destroy(d.publicId, {
      resource_type: d.resourceType,
      type: 'authenticated',
      invalidate: true,
    });
  }

  /** Always proxied through the API, so access control is enforced on every download. */
  async getSignedUrl(): Promise<string | null> {
    return null;
  }
}