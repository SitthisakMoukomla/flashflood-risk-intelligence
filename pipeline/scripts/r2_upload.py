"""Put one file in the Cloudflare R2 bucket the app reads tile archives from.

Same environment contract as the GitHub Action that publishes the SAR
archive (script 14), so the key you already keep in the repo secrets works
here unchanged:

  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  R2_PUBLIC_BASE   (optional — printed as the public URL)

boto3 splits anything over 8 MB into a multipart upload on its own, which
is what makes a multi-GB PMTiles archive practical over a home connection.

Run:
  uv run python scripts/r2_upload.py data/output/buildings.pmtiles
  uv run python scripts/r2_upload.py data/output/buildings.pmtiles --key buildings.pmtiles
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import boto3
import click
from boto3.s3.transfer import TransferConfig

R2_ENV = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")


@click.command()
@click.argument("path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--key", default=None, help="Object key (default: the file name)")
@click.option("--cache-seconds", default=86400, show_default=True,
              help="Cache-Control max-age; archives that change rarely can be cached longer")
def main(path: Path, key: str | None, cache_seconds: int) -> None:
    missing = [k for k in R2_ENV if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"missing env: {', '.join(missing)}")
    key = key or path.name
    size = path.stat().st_size

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    done = 0
    last_pct = -1

    def progress(n: int) -> None:
        nonlocal done, last_pct
        done += n
        pct = int(done * 100 / size) if size else 100
        if pct != last_pct and pct % 5 == 0:
            last_pct = pct
            click.echo(f"\r[r2] {key}  {done / 1e6:,.0f} / {size / 1e6:,.0f} MB  {pct}%", nl=False, err=True)

    client.upload_file(
        str(path),
        os.environ["R2_BUCKET"],
        key,
        ExtraArgs={
            # Range requests from the browser need a type R2 will serve ranges for.
            "ContentType": "application/octet-stream",
            "CacheControl": f"public, max-age={cache_seconds}",
        },
        Config=TransferConfig(multipart_chunksize=64 * 1024 * 1024, max_concurrency=4),
        Callback=progress,
    )
    click.echo("", err=True)

    head = client.head_object(Bucket=os.environ["R2_BUCKET"], Key=key)
    if head["ContentLength"] != size:
        raise SystemExit(f"size mismatch after upload: {head['ContentLength']} != {size}")
    base = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")
    click.echo(f"[r2] uploaded {key}  {size / 1e6:,.1f} MB  → " + (f"{base}/{key}" if base else "(no R2_PUBLIC_BASE set)"))


if __name__ == "__main__":
    sys.exit(main())
