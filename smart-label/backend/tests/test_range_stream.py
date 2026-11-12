"""视频 Range：每次最多回 4MB，不再顺着一条连接把整个文件推完（占着浏览器的连接，别的接口全排队）。"""

from app.services import range_stream as rs


class _Req:
    def __init__(self, rng=None):
        self.headers = {"range": rng} if rng else {}


def _body(run, resp):
    out = []

    async def drain():
        async for c in resp.body_iterator:
            out.append(c)

    run(drain())
    return b"".join(out)


def test_视频从头到尾的请求_只回4MB(tmp_path, run):
    f = tmp_path / "v.mp4"
    size = rs.MEDIA_RANGE_CAP * 3 + 123
    f.write_bytes(b"x" * size)
    resp = run(rs.stream_file(_Req("bytes=0-"), str(f), "video/mp4"))
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 0-{rs.MEDIA_RANGE_CAP - 1}/{size}"
    assert len(_body(run, resp)) == rs.MEDIA_RANGE_CAP
    # 接着要：从中间开始、到结尾不足 4MB 的照样给全
    tail = run(rs.stream_file(_Req(f"bytes={rs.MEDIA_RANGE_CAP * 3}-"), str(f), "video/mp4"))
    assert tail.headers["content-range"] == f"bytes {rs.MEDIA_RANGE_CAP * 3}-{size - 1}/{size}"


def test_不是视频的不截(tmp_path, run):
    f = tmp_path / "a.pdf"
    size = rs.MEDIA_RANGE_CAP * 2
    f.write_bytes(b"x" * size)
    resp = run(rs.stream_file(_Req("bytes=0-"), str(f), "application/pdf"))
    assert resp.headers["content-range"] == f"bytes 0-{size - 1}/{size}"
    # 不带 Range（下载整个文件）不受影响
    full = run(rs.stream_file(_Req(), str(tmp_path / "a.pdf"), "video/mp4"))
    assert full.status_code == 200 and full.headers["content-length"] == str(size)
