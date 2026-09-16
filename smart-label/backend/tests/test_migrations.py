"""迁移链本身的检查。

这些错误的共同点是：**代码全绿、测试全过，部署时才炸**，而且炸在
migrate 容器里，正文只有一句 "exit 255"。

真事：新增 label_seconds 那个迁移，我按 `ls | tail -3` 挑的 down_revision
——那是**按文件名排序**，不是修订链的头。结果链上出现两个头，
alembic 拒绝升级，整个部署挂掉。
"""

import os
import re

VERSIONS = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")


def _graph():
    revs = {}
    for f in os.listdir(VERSIONS):
        if not f.endswith(".py"):
            continue
        with open(os.path.join(VERSIONS, f), encoding="utf-8") as fh:
            s = fh.read()
        r = re.search(r'^revision\s*=\s*["\']([^"\']+)', s, re.M)
        p = re.search(r'^down_revision\s*=\s*(?:["\']([^"\']+)["\']|None)', s, re.M)
        if r:
            revs[r.group(1)] = (p.group(1) if (p and p.group(1)) else None, f)
    return revs


def test_exactly_one_head():
    """**只能有一个头。**

    多头的时候 alembic 直接拒绝 upgrade，部署当场挂，而错误信息只有
    "exit 255"——要连进容器看日志才知道是迁移的事。
    """
    revs = _graph()
    children = {}
    for r, (p, _) in revs.items():
        children.setdefault(p, []).append(r)
    heads = [r for r in revs if r not in children]
    assert len(heads) == 1, (
        "迁移链有多个头，alembic 会拒绝升级：\n  "
        + "\n  ".join(f"{h}  {revs[h][1]}" for h in heads)
        + "\n把新迁移的 down_revision 指到真正的头上（不是按文件名排序的最后一个）"
    )


def test_exactly_one_root():
    """只能有一个根。两个根意味着有一条链是孤立的，那部分永远不会被执行。"""
    revs = _graph()
    roots = [r for r, (p, _) in revs.items() if p is None]
    assert len(roots) == 1, f"有多个根：{[(r, revs[r][1]) for r in roots]}"


def test_every_parent_exists():
    """down_revision 指向的修订必须真的存在。

    打错一个字符的表现是 alembic 报 "Can't locate revision"，
    同样是部署时才发现。
    """
    revs = _graph()
    for r, (p, f) in revs.items():
        if p is not None:
            assert p in revs, f"{f} 的 down_revision={p} 不存在"


def test_no_cycles():
    """链上不能有环——有环的话 alembic 会一直绕。"""
    revs = _graph()
    for start in revs:
        seen, cur = set(), start
        while cur is not None:
            if cur in seen:
                raise AssertionError(f"从 {start} 出发有环，经过 {cur}")
            seen.add(cur)
            cur = revs[cur][0] if cur in revs else None


def test_revision_id_matches_filename():
    """文件名里的那串 id 要跟 revision 一致。

    对不上的话，人按文件名去找某个修订会找错——而迁移链上出问题时，
    第一件事就是按 id 找文件。
    """
    revs = _graph()
    for r, (_, f) in revs.items():
        assert f.startswith(r), f"{f} 的文件名跟 revision={r} 对不上"
