# /// script
# dependencies = ["cos-python-sdk-v5==1.9.45"]
# ///
"""将已装配的五个浏览器入口、两份材质包和来源声明发布到 COS。"""

import argparse
import os
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urlsplit

from qcloud_cos import CosConfig, CosS3Client


FILES = {
    "default-materials.zip": "application/zip",
    "material-info.zip": "application/zip",
    "THIRD_PARTY_NOTICES.txt": "text/plain; charset=utf-8",
    "r2-mc.js": "text/javascript; charset=utf-8",
    "r2-core.js": "text/javascript; charset=utf-8",
    "r2-link.js": "text/javascript; charset=utf-8",
    "r2-materials.js": "text/javascript; charset=utf-8",
    "r2-frontend.js": "text/javascript; charset=utf-8",
}


def publish(directory: Path) -> None:
    """用本次构建的文件直接更新 r2/ 下的公开入口。"""
    access_url = (os.environ.get("T_COS_ACCESS_URL") or "https://omega-1259160345.cos.accelerate.myqcloud.com").rstrip("/")
    service_url = os.environ.get("T_COS_SERVICE_URL") or "https://ap-nanjing.myqcloud.com"
    bucket = urlsplit(access_url).hostname.split(".")[0]
    region = urlsplit(service_url).hostname.split(".")[0]
    client = CosS3Client(CosConfig(
        Region=region,
        SecretId=os.environ["T_COS_SECRET_ID"],
        SecretKey=os.environ["T_COS_SECRET_KEY"],
        Scheme="https",
    ))
    # 全套文件都能读取后再更新公开地址，避免误选目录时发布半套产物。
    with ExitStack() as stack:
        contents = {name: stack.enter_context((directory / name).open("rb")) for name in FILES}
        for name, content in contents.items():
            client.put_object(
                Bucket=bucket,
                Key=f"r2/{name}",
                Body=content,
                EnableMD5=True,
                ContentType=FILES[name],
                CacheControl="no-cache",
            )
            print(f"{access_url}/r2/{name}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parent / "release-browser/dist/standalone",
        help="发布文件所在目录，默认使用本地装配的 standalone 目录",
    )
    args = parser.parse_args()
    publish(directory=args.directory)
