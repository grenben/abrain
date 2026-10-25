#!/usr/bin/env python3
"""Explicit subscription acceptance with synthetic fixtures and an ephemeral login copy.

Requires a qualified native Linux host. Never run automatically from unit tests.
The retained root contains a synthetic database; export only sanitized receipts.
"""
import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time
import uuid
import zlib


def synthetic_image():
    font = {
        'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
        'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
        'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
        'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
        'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
        'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
        '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
        '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
        ' ': ['00000'] * 7,
    }
    text, scale = 'ORCHARD 12', 8
    width, height = (len(text) * 6 + 8) * scale, 15 * scale
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            gx, gy = x // scale - 4, y // scale - 4
            index, col = gx // 6, gx % 6
            black = 0 <= index < len(text) and 0 <= gy < 7 and col < 5 and font[text[index]][gy][col] == '1'
            row.extend((0, 0, 0) if black else (255, 255, 255))
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--auth-file', type=Path, required=True)
    parser.add_argument('--models', type=Path, help='JSON object with exactly four explicitly approved tier pins; required for a new batch')
    parser.add_argument('--roles', required=True)
    parser.add_argument('--support-roles', help='Additional explicitly enabled workflow dependencies; no standalone case is run for these roles')
    parser.add_argument('--calibration-repair', action='store_true', help='New batch only: explicitly allow calibration one rewrite and second voice review (four calls total)')
    parser.add_argument('--root', type=Path, help='Resume the same retained batch and allowance')
    parser.add_argument('--retry', action='store_true', help='Retry a failed role within its existing two-attempt allowance')
    args = parser.parse_args()
    roles = args.roles.split(',')
    support = args.support_roles.split(',') if args.support_roles else []
    if not (1 <= len(roles) and len(roles + support) <= 8 and len(set(roles + support)) == len(roles + support)):
        parser.error('select one to eight distinct roles per bounded batch')
    if args.calibration_repair and ('take-calibration' not in roles or 'calibration-voice-judge' not in roles + support):
        parser.error('calibration repair requires take-calibration and its voice-judge dependency')
    repo = Path(__file__).resolve().parent.parent
    if args.root:
        root = args.root.resolve(strict=True)
        assert (root / '.gbrain-live-acceptance').read_text() == 'synthetic-only-v1\n'
        assert root.stat().st_mode & 0o077 == 0
        assert args.models is None, 'resuming cannot replace the approved model pins'
        assert args.support_roles is None, 'resuming retains the originally enabled supporting roles'
        assert not args.calibration_repair, 'resuming cannot extend an existing allowance'
    else:
        assert args.models and not args.retry, 'a new batch requires --models, without --retry'
        models = json.loads(args.models.read_text())
        assert set(models) == {'utility', 'reasoning', 'deep', 'subagent'}
        assert all(isinstance(model, str) and model.startswith('codex-cli:') for model in models.values())
        root = Path(tempfile.mkdtemp(prefix='gbrain-live-roles-', dir='/var/tmp'))
        for name in ['home', 'codex', 'tmp']:
            (root / name).mkdir(mode=0o700)
        (root / '.gbrain-live-acceptance').write_text('synthetic-only-v1\n')
        (root / 'models.json').write_text(json.dumps(models))
        (root / 'manifest.json').write_text(json.dumps({
            'runId': 'acceptance-' + str(uuid.uuid4()),
            'deadline': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat(),
            'maxAttempts': 16, 'maxTurns': 16, 'roles': roles + support, 'selectedRoles': roles,
            'roleLimits': {'take-calibration': 4} if args.calibration_repair else {},
        }))
        (root / 'orchard.png').write_bytes(synthetic_image())
    print(json.dumps({'root': str(root)}), flush=True)
    with (root / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest = json.loads((root / 'manifest.json').read_text())
        assert set(roles) <= set(manifest.get('roles', roles)), 'resume only roles in this batch'
        original = args.auth_file.read_bytes()
        auth = json.loads(original)
        assert auth.get('auth_mode') == 'chatgpt', 'subscription login required'
        token = auth['tokens']['access_token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
        assert claims['exp'] > time.time() + 900, 'refresh login outside this harness before retrying'
        private_auth = root / 'codex/auth.json'
        # Exclusive create refuses a forgotten or concurrently active login copy.
        with private_auth.open('xb') as target:
            os.fchmod(target.fileno(), 0o600)
            target.write(original)
        number = len(list(root.glob('run-*.log'))) + 1
        log = root / f'run-{number}.log'
        env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'GBRAIN_HOME': str(root / 'home'),
               'CODEX_HOME': str(root / 'codex'), 'TMPDIR': str(root / 'tmp'), 'LANG': 'C.UTF-8'}
        command = ['bun', '--no-env-file', 'scripts/private-codex-live-acceptance.ts', '--live', '--root', str(root), '--roles', args.roles]
        if args.retry:
            command.append('--retry')
        started = time.monotonic()
        result = None
        try:
            with log.open('w') as output:
                result = subprocess.run(command, cwd=repo, env=env, stdout=output, stderr=subprocess.STDOUT)
        finally:
            private_auth.unlink()
            unchanged = args.auth_file.read_bytes() == original
            record = {'exit': result.returncode if result else None, 'seconds': round(time.monotonic() - started, 2),
                      'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest() if log.exists() else None,
                      'original_auth_file_unchanged': unchanged, 'temporary_auth_file_removed': not private_auth.exists()}
            (root / f'run-{number}.json').write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps(record), flush=True)
            assert unchanged, 'original login changed externally during acceptance'
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
