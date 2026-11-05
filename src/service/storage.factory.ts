import { v2 as cloudinary } from 'cloudinary';
import type { Env } from '../config/env.js';
import { CloudinaryStorageService, type CloudinaryClient } from './cloudinary.storage.js';
import { LocalStorageService, type StorageService } from './storage.service.js';

/**
 * Picks the attachment storage from env:
 *   STORAGE_DRIVER=cloudinary -> Cloudinary (authenticated assets, downloads proxied through the API)
 *   STORAGE_DRIVER=local      -> files on local disk under UPLOAD_DIR (development)
 */
export function createStorage(env: Env): StorageService {
  if (env.STORAGE_DRIVER === 'cloudinary') {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    return new CloudinaryStorageService(cloudinary as unknown as CloudinaryClient, env.CLOUDINARY_FOLDER);
  }
  return new LocalStorageService(env.UPLOAD_DIR);
}