"""
media_server.py
===============
替代 nginx 的本地静态文件服务，支持 CORS（Label Studio 需要跨域访问媒体文件）。
默认端口 8182，与服务器端 nginx 保持一致。

用法：
  python win/media_server.py
  python win/media_server.py --dir C:/自定义目录 --port 8182
"""

import argparse
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CORSHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        # 只打印非 200 的请求，减少刷屏
        if args[1] != "200":
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description="本地媒体文件静态服务（替代 nginx）")
    parser.add_argument("--dir",  default=None, help="媒体文件目录，默认 Label Studio 上传目录")
    parser.add_argument("--port", type=int, default=8182, help="端口，默认 8182")
    args = parser.parse_args()

    media_dir = args.dir or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
        "label-studio", "label-studio", "media"
    )
    media_dir = os.path.abspath(media_dir)

    if not os.path.exists(media_dir):
        print(f"❌ 目录不存在: {media_dir}")
        print("   用 --dir 指定正确的媒体文件目录")
        return

    os.chdir(media_dir)
    server = HTTPServer(("0.0.0.0", args.port), CORSHandler)
    print(f"✅ 媒体文件服务已启动")
    print(f"   目录: {media_dir}")
    print(f"   地址: http://localhost:{args.port}")
    print(f"   Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
