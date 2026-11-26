"""将通过测试的三个浏览器入口和配套材质包发布到 COS。"""

import argparse
import os
from pathlib import Path
from urllib.parse import urlsplit

from qcloud_cos import CosConfig, CosS3Client


FILES = {
    "default-materials.zip": "application/zip",
    "material-info.zip": "application/zip",
    "THIRD_PARTY_NOTICES.txt": "text/plain; charset=utf-8",
    "r2-core.js": "text/javascript; charset=utf-8",
    "r2-link.js": "text/javascript; charset=utf-8",
    "r2-materials.js": "text/javascript; charset=utf-8",
    "r2-frontend.js": "text/javascript; charset=utf-8",
}


def publish(directory: Path) -> None:
    """用本次构建的文件直接更新 r2/ 下的公开入口。"""
    access_url = os.environ["T_COS_ACCESS_URL"].rstrip("/")
    bucket = urlsplit(access_url).hostname.split(".")[0]
    region = urlsplit(os.environ["T_COS_SERVICE_URL"]).hostname.split(".")[0]
    client = CosS3Client(CosConfig(
        Region=region,
        SecretId=os.environ["T_COS_SECRET_ID"],
        SecretKey=os.environ["T_COS_SECRET_KEY"],
        Scheme="https",
    ))
    for name, content_type in FILES.items():
        with (directory / name).open("rb") as content:
            client.put_object(
                Bucket=bucket,
                Key=f"r2/{name}",
                Body=content,
                EnableMD5=True,
                ContentType=content_type,
                CacheControl="no-cache",
            )
        print(f"{access_url}/r2/{name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="工作流整理出的 r2-browser 目录")
    args = parser.parse_args()
    publish(directory=args.directory)
