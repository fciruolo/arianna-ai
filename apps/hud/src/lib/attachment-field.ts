/**
 * The attachments of the field of a chat (D-247): pasted with ⌘V, dropped on
 * the field or chosen with «Allega file». Each file is checked here first
 * (attachmentFileProblem, attachmentPlaceProblem), an image larger than
 * MAX_IMAGE_SIDE is made smaller in the page, then it is uploaded and kept
 * pending by the core until the message leaves. The preview of an image not
 * sent yet is a `data:` URL of the bytes that leave (the page's policy admits
 * `data:` images, never `blob:`).
 */
import { computed, ref } from 'vue';

import { discardAttachment, uploadAttachment } from './api.ts';
import { attachmentFileProblem, attachmentKind, attachmentPlaceProblem, attachmentUrl, fittedSize, type AttachmentInfo, type AttachmentPlace } from './attachments.ts';
import { errorText } from './italian.ts';

export interface FieldAttachment {
  key: string;
  name: string;
  kind: 'image' | 'text';
  /** The preview of an image: a `data:` URL of what was uploaded, the core's address once restored; null before. */
  preview: string | null;
  /** What the core kept; null while it is uploaded. */
  info: AttachmentInfo | null;
}

let counter = 0;

/** The bytes of a blob in base64, without the `data:` prefix. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed'));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * The image as it leaves the page: the same file when it fits MAX_IMAGE_SIDE
 * (or is a GIF, whose frames would be lost), a smaller copy of the same type
 * otherwise (PNG when the browser cannot write that type).
 */
async function fitted(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // The core checks the bytes anyway: an image the browser cannot open goes as it is.
    return file;
  }
  try {
    const size = fittedSize(bitmap.width, bitmap.height);
    if (size.width === bitmap.width && size.height === bitmap.height) return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, file.type, 0.9);
    });
    return blob ?? file;
  } finally {
    bitmap.close();
  }
}

export function useAttachmentField(place: () => AttachmentPlace, problem: (text: string) => void) {
  const items = ref<FieldAttachment[]>([]);
  const uploading = computed(() => items.value.some((item) => item.info === null));
  const ready = computed(() => items.value.flatMap((item) => (item.info === null ? [] : [item.info])));

  async function addOne(file: File): Promise<void> {
    const fileProblem = attachmentFileProblem(file, items.value.length);
    if (fileProblem !== undefined) {
      problem(fileProblem);
      return;
    }
    const kind = attachmentKind(file) ?? 'text';
    const item: FieldAttachment = { key: `a${String((counter += 1))}`, name: file.name, kind, preview: null, info: null };
    items.value = [...items.value, item];
    try {
      const blob = kind === 'image' ? await fitted(file) : file;
      const data = await base64Of(blob);
      if (kind === 'image') {
        const preview = `data:${blob.type === '' ? file.type : blob.type};base64,${data}`;
        items.value = items.value.map((entry) => (entry.key === item.key ? { ...entry, preview } : entry));
      }
      const info = await uploadAttachment(file.name, data);
      // Removed with «×» while it was uploaded: the core forgets it too.
      if (!items.value.some((entry) => entry.key === item.key)) {
        void discardAttachment(info.id).catch(() => undefined);
        return;
      }
      items.value = items.value.map((entry) => (entry.key === item.key ? { ...entry, info } : entry));
    } catch (cause) {
      items.value = items.value.filter((entry) => entry.key !== item.key);
      problem(errorText(cause));
    }
  }

  /** Files pasted, dropped or chosen: refused at once where this conversation takes none. */
  async function add(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const placeProblem = attachmentPlaceProblem(place());
    if (placeProblem !== undefined) {
      problem(placeProblem);
      return;
    }
    for (const file of files) await addOne(file);
  }

  /** «×»: gone from the field, and from the core when it was kept there. */
  function remove(key: string): void {
    const item = items.value.find((entry) => entry.key === key);
    if (item === undefined) return;
    items.value = items.value.filter((entry) => entry.key !== key);
    if (item.info !== null) void discardAttachment(item.info.id).catch(() => undefined);
  }

  /** The message leaves with them: the field empties, the core keeps them with the message. */
  function take(): AttachmentInfo[] {
    const taken = ready.value;
    items.value = [];
    return taken;
  }

  /** A message the core refused comes back with its attachments, still pending there. */
  function restore(infos: readonly AttachmentInfo[]): void {
    const known = new Set(items.value.flatMap((item) => (item.info === null ? [] : [item.info.id])));
    const back = infos
      .filter((info) => !known.has(info.id))
      .map((info) => ({ key: `a${String((counter += 1))}`, name: info.name, kind: info.kind, preview: info.kind === 'image' ? attachmentUrl(info.id) : null, info }));
    items.value = [...items.value, ...back];
  }

  /** Another conversation: what was pasted here is not carried there; the core forgets it. */
  function drop(): void {
    for (const item of items.value) remove(item.key);
  }

  return { items, uploading, ready, add, remove, take, restore, drop };
}
