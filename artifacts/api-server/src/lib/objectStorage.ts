import { createReadStream, type ReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export class ObjectNotFoundError extends Error {
  constructor() {
    super(
      "Audio file not found in persistent storage. Existing recordings must be migrated with their original object keys.",
    );
    this.name = "ObjectNotFoundError";
  }
}

class StoredAudioFile {
  constructor(private readonly path: string) {}

  async getMetadata(): Promise<[{ size: number; contentType: string }]> {
    const info = await stat(this.path);
    let contentType = "application/octet-stream";
    try {
      contentType =
        JSON.parse(await readFile(`${this.path}.json`, "utf8")).contentType ||
        contentType;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [{ size: info.size, contentType }];
  }

  createReadStream(options?: { start: number; end: number }): ReadStream {
    return createReadStream(this.path, options);
  }

  async delete(): Promise<void> {
    await unlink(this.path);
    await unlink(`${this.path}.json`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Single-instance persistent volume; stored keys remain /objects/uploads/<uuid>. */
export class ObjectStorageService {
  getStorageDirectory(): string {
    return resolve(process.env.STORAGE_DIR || "./data/objects");
  }

  private resolveKey(objectPath: string): string {
    if (!/^\/objects\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(objectPath)) {
      throw new ObjectNotFoundError();
    }
    const root = this.getStorageDirectory();
    const path = resolve(root, objectPath.slice("/objects/".length));
    if (!path.startsWith(`${root}${sep}`)) throw new ObjectNotFoundError();
    return path;
  }

  async persistFile(sourcePath: string, contentType: string): Promise<string> {
    const key = `/objects/uploads/${randomUUID()}`;
    const destination = this.resolveKey(key);
    const temporary = `${destination}.partial`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(sourcePath, temporary);
      await writeFile(`${destination}.json`, JSON.stringify({ contentType }), {
        mode: 0o600,
      });
      await rename(temporary, destination);
      return key;
    } catch (error) {
      await Promise.all(
        [temporary, `${destination}.json`].map((path) =>
          unlink(path).catch(() => {}),
        ),
      );
      throw error;
    }
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredAudioFile> {
    const path = this.resolveKey(objectPath);
    try {
      if (!(await stat(path)).isFile()) throw new ObjectNotFoundError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ObjectNotFoundError();
      throw error;
    }
    return new StoredAudioFile(path);
  }
}
