import { readSync } from 'node:fs';
import { withConfigPublicationLock } from '../../src/core/config-publication.ts';
import { publishManagedInitConfigFile } from '../../src/core/config-managed-publication.ts';
import { ConfigPublicationRefusedError } from '../../src/core/config-publication.ts';

const [mode, directory, destination] = process.argv.slice(2);
const reference = { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' } as const;

try {
  if (mode === 'hold') {
    withConfigPublicationLock(directory!, () => {
      process.stdout.write('locked\n');
      const byte = Buffer.alloc(1);
      while (readSync(0, byte, 0, 1, null) > 0) { if (byte[0] === 10) break; }
    });
  } else if (mode === 'publish') {
    publishManagedInitConfigFile(reference, directory!, destination!);
  } else {
    process.exitCode = 2;
    throw new Error('invalid mode');
  }
  process.stdout.write(mode === 'hold' ? 'released\n' : 'published\n');
} catch (error) {
  process.stdout.write(error instanceof ConfigPublicationRefusedError ? 'refused\n' : 'failed\n');
  process.exitCode = 1;
}
