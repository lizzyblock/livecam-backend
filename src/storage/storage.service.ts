import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { customAlphabet } from 'nanoid';

const id = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

/**
 * Storj (S3-compatible) object storage. Storj serves files directly with
 * free egress up to 3x stored data, so this doubles as the delivery layer —
 * no separate CDN bill.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('storage.bucket')!;
    this.client = new S3Client({
      region: 'us-1',
      endpoint: config.get<string>('storage.endpoint'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get<string>('storage.accessKeyId') ?? '',
        secretAccessKey: config.get<string>('storage.secretAccessKey') ?? '',
      },
    });
  }

  buildKey(workspaceId: string, kind: 'image' | 'video' | 'audio', ext: string) {
    const date = new Date().toISOString().slice(0, 10);
    return `${workspaceId}/${kind}/${date}/${id()}.${ext}`;
  }

  async upload(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /** Pull a generated file from an upstream provider URL into our bucket. */
  async ingestFromUrl(key: string, url: string, contentType: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch asset from provider: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await this.upload(key, buf, contentType);
    return { key, sizeBytes: buf.byteLength };
  }

  async signedDownloadUrl(key: string, expiresInSeconds = 3600) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async signedUploadUrl(key: string, contentType: string, expiresInSeconds = 900) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }
}
