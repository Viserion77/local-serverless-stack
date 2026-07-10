// Shared file primitives for the engine store: atomic replace (write tmp +
// rename — rename is the commit point) and buffered append, each with opt-in
// fsync for the paranoid durability mode.

import fsp from 'fs/promises';
import path from 'path';

export async function ensureDirFor(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

export async function atomicWriteFile(filePath: string, data: string | Buffer, fsync: boolean): Promise<void> {
  await ensureDirFor(filePath);
  const tmpPath = `${filePath}.tmp`;
  const handle = await fsp.open(tmpPath, 'w');
  try {
    await handle.writeFile(data);
    if (fsync) await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, filePath);
}

export async function appendToFile(filePath: string, data: string, fsync: boolean): Promise<void> {
  await ensureDirFor(filePath);
  const handle = await fsp.open(filePath, 'a');
  try {
    await handle.write(data);
    if (fsync) await handle.sync();
  } finally {
    await handle.close();
  }
}
