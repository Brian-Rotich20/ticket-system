import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File Storage boundary (local disk now, S3 / blob storage later). */
export interface StorageService {
  save(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Pre-signed URL for object stores. Return null when the API itself must stream the file (local disk). */
  getSignedUrl(key: string): Promise<string | null>;
}

export class LocalStorageService implements StorageService {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key'); // path traversal guard
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o640 });
  }
  read(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
  async getSignedUrl(): Promise<string | null> {
    return null;
  }
}

export class InMemoryStorageService implements StorageService {
  readonly files = new Map<string, Buffer>();
  async save(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async read(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error('not found');
    return f;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async getSignedUrl() {
    return null;
  }
}
