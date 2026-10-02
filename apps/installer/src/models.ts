// Local model weights (task 1.17, docs/INSTALLER-PORTABILITY.md): the catalog
// travels, the files of the models assigned to a role are downloaded again
// where they are needed (task 1.18). Each file is written to `<file>.part`,
// resumed with an HTTP Range request after an interruption, and renamed only
// once its size and sha256 match the catalog.
// Downloads only fetch public files: nothing about the user leaves this machine
// except the request itself.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AriannaConfig, CatalogEntry, ModelCatalog, ModelFile } from '@arianna/config';

export const MODELS_DIR = 'models';
export const PART_SUFFIX = '.part';

export type FileState = 'ok' | 'present' | 'missing' | 'partial' | 'wrong-size' | 'wrong-hash';

export interface FileStatus {
  model: string;
  file: ModelFile;
  /** Absolute path of the file. */
  target: string;
  /**
   * `present`: the size matches and the hash was not computed (quick check);
   * `ok`: size and sha256 match.
   */
  state: FileState;
}

export type ModelErrorCode = 'http-status' | 'too-large' | 'wrong-size' | 'wrong-hash' | 'redirects' | 'insecure-url' | 'network';

/** Messages name the model file and a code, never a response body. */
export class ModelError extends Error {
  override name = 'ModelError';
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Download {
  /** 200 (whole file) or 206 (from the requested offset). */
  status: number;
  body: Readable;
  /** `Content-Range` of a 206: where the bytes start. */
  contentRange?: string;
}

/** Opens `url` from byte `offset`; the default is `httpsGet` (src/http.ts). */
export type Fetcher = (url: string, offset: number) => Promise<Download>;

export function fileTarget(data: string, model: string, file: ModelFile): string {
  return join(data, MODELS_DIR, model, file.path);
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function sizeOf(path: string): number | undefined {
  return existsSync(path) ? statSync(path).size : undefined;
}

/** The catalog entries assigned to a role, each once. */
export function selectedModels(config: Pick<AriannaConfig, 'roles'>, catalog: ModelCatalog): CatalogEntry[] {
  const ids = new Set(Object.values(config.roles));
  return catalog.models.filter((model) => ids.has(model.id));
}

/**
 * Compares `data/models` with the models to install. Without `hash` only sizes are
 * checked (seconds); with it every present file is read (minutes for tens of GB).
 */
export async function modelStatus(models: readonly CatalogEntry[], data: string, options: { hash?: boolean } = {}): Promise<FileStatus[]> {
  const statuses: FileStatus[] = [];
  for (const model of models) {
    for (const file of model.files) {
      const target = fileTarget(data, model.id, file);
      const size = sizeOf(target);
      let state: FileState;
      if (size === undefined) state = sizeOf(`${target}${PART_SUFFIX}`) === undefined ? 'missing' : 'partial';
      else if (size !== file.sizeBytes) state = 'wrong-size';
      else if (options.hash !== true) state = 'present';
      else state = (await sha256Of(target)) === file.sha256 ? 'ok' : 'wrong-hash';
      statuses.push({ model: model.id, file, target, state });
    }
  }
  return statuses;
}

export interface PullOptions {
  fetch: Fetcher;
  /** Called with the bytes written so far for the current file. */
  onProgress?: (status: FileStatus, bytes: number) => void;
}

/** Downloads one file to its target, resuming a `.part` left by an earlier attempt. */
export async function pullFile(status: FileStatus, options: PullOptions): Promise<void> {
  const { file, target } = status;
  const part = `${target}${PART_SUFFIX}`;
  const label = `${status.model}/${file.path}`;
  mkdirSync(dirname(target), { recursive: true });

  let offset = sizeOf(part) ?? 0;
  if (offset > file.sizeBytes) {
    rmSync(part);
    offset = 0;
  }
  if (offset < file.sizeBytes) {
    let download = await options.fetch(file.url, offset);
    if (download.status === 206 && rangeStart(download.contentRange) !== offset) {
      // Bytes from somewhere else would only be thrown away by the hash check: start over.
      download.body.destroy();
      offset = 0;
      download = await options.fetch(file.url, 0);
    }
    if (download.status === 200) offset = 0; // the server ignored the Range header: start over
    else if (download.status === 416) {
      // The .part is longer than the file on the server: it changed upstream.
      download.body.destroy();
      rmSync(part, { force: true });
      throw new ModelError('http-status', `${label}: the partial download no longer matches the server, discarded: run pull again`);
    } else if (download.status !== 206) {
      download.body.destroy();
      throw new ModelError('http-status', `${label}: HTTP ${String(download.status)}`);
    }
    let written = offset;
    const counted = async function* (source: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        written += buffer.length;
        if (written > file.sizeBytes) throw new ModelError('too-large', `${label}: larger than the catalog says`);
        options.onProgress?.(status, written);
        yield buffer;
      }
    };
    try {
      await pipeline(download.body, counted, createWriteStream(part, { flags: offset === 0 ? 'w' : 'a' }));
    } catch (error) {
      if (error instanceof ModelError) throw error;
      // The .part stays: the next pull resumes from it.
      throw new ModelError('network', `${label}: download interrupted, run pull again`);
    }
  }

  const size = sizeOf(part) ?? 0;
  if (size !== file.sizeBytes) {
    // A short file can be resumed: keep it.
    throw new ModelError('wrong-size', `${label}: ${String(size)} of ${String(file.sizeBytes)} bytes, run pull again`);
  }
  if ((await sha256Of(part)) !== file.sha256) {
    rmSync(part);
    throw new ModelError('wrong-hash', `${label}: sha256 does not match the catalog, download discarded`);
  }
  // On disk before the rename: after a power cut a file of the right size
  // must also have the right bytes, since the doctor only checks sizes.
  const fd = openSync(part, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(part, target);
}

function rangeStart(contentRange: string | undefined): number | undefined {
  const match = /^bytes (\d+)-/.exec(contentRange ?? '');
  return match === null ? undefined : Number(match[1]);
}

/**
 * Downloads every file that is not present; a file of the wrong size is
 * replaced. With `verify` every present file is hashed first and one with the
 * wrong sha256 is replaced too.
 */
export async function pullModels(models: readonly CatalogEntry[], data: string, options: PullOptions & { verify?: boolean }): Promise<FileStatus[]> {
  const pulled: FileStatus[] = [];
  for (const status of await modelStatus(models, data, { hash: options.verify === true })) {
    if (status.state === 'present' || status.state === 'ok') continue;
    if (status.state === 'wrong-size' || status.state === 'wrong-hash') rmSync(status.target);
    await pullFile(status, options);
    pulled.push({ ...status, state: 'ok' });
  }
  return pulled;
}
