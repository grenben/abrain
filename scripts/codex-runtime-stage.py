#!/usr/bin/env python3
"""Stage the already inspected Codex build; never execute it or activate GBrain.

Default operation is read-only. --stage requires an interactive operator's sudo.
The fixed digest is the 0.162.0 Linux musl build recorded in the runtime review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import sys

SHA256 = "50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38"
DESTINATION = Path("/usr/local/lib/gbrain-codex") / SHA256 / "codex"
MAX_BYTES = 1024 * 1024 * 1024


def digest_file(fd, output=None):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
        raise ValueError("source must be a bounded regular file")
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    total = 0
    while chunk := os.read(fd, 1024 * 1024):
        total += len(chunk)
        if total > MAX_BYTES:
            raise ValueError("source exceeded size bound")
        digest.update(chunk)
        if output is not None:
            output.write(chunk)
    after = os.fstat(fd)
    if (total != info.st_size or after.st_size != info.st_size
            or after.st_mtime_ns != info.st_mtime_ns or after.st_ctime_ns != info.st_ctime_ns):
        raise ValueError("source changed while reading")
    return digest.hexdigest()


def open_file(path, directory=None):
    return os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)


def protected_directory(path):
    """Walk using directory descriptors; never follow links or change existing modes."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        root = os.fstat(fd)
        if root.st_uid != 0 or root.st_mode & 0o022 or not root.st_mode & 0o001:
            raise ValueError("destination root is not protected")
        for part in path.parts[1:]:
            created = False
            try:
                os.mkdir(part, 0o755, dir_fd=fd)
                created = True
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                info = os.fstat(child)
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError("destination ancestor is not protected")
                if created:
                    # Only our new directory: preserve traversal through a restrictive umask.
                    os.fchmod(child, 0o755)
                elif not info.st_mode & 0o001:
                    raise ValueError("existing destination ancestor is not traversable")
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def verify_destination(directory):
    fd = open_file("codex", directory)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o222 or info.st_mode & 0o005 != 0o005:
            raise ValueError("existing destination is not a protected executable")
        if digest_file(fd) != SHA256:
            raise ValueError("existing destination has a different digest")
    finally:
        os.close(fd)


def stage(source):
    directory = protected_directory(DESTINATION.parent)
    temporary = ".stage-" + secrets.token_hex(16)
    created = False
    try:
        try:
            verify_destination(directory)
            return "already-staged"
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        created = True
        with os.fdopen(fd, "wb") as output:
            if digest_file(source, output) != SHA256:
                raise ValueError("copied source digest differs from inspected build")
            output.flush()
            os.fchmod(output.fileno(), 0o555)
            os.fsync(output.fileno())
        # link is atomic and refuses an existing destination, including a symlink.
        os.link(temporary, "codex", src_dir_fd=directory, dst_dir_fd=directory,
                follow_symlinks=False)
        os.fsync(directory)
        verify_destination(directory)
        return "staged"
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--stage", action="store_true", help="create the protected copy; requires root")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("the inspected build and protected runtime boundary require Linux")
    if not args.source.is_absolute():
        parser.error("source must be absolute")
    if args.stage and os.geteuid() != 0:
        parser.error("--stage needs an operator's sudo; no files were changed")
    source = open_file(args.source)
    try:
        if digest_file(source) != SHA256:
            raise ValueError("source digest differs from the inspected 0.162.0 build")
        status = stage(source) if args.stage else "source-verified-read-only"
        print(json.dumps({"status": status, "sha256": SHA256,
                          "destination": str(DESTINATION), "activated": False}))
    finally:
        os.close(source)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "refused", "error": str(error), "activated": False}))
        raise SystemExit(1)
