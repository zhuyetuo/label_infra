"""
删样本：数据库这边的连带清理，NAS 上的文件一个都不动。

抽出来是因为有两个入口要用同一套：管理员在列表里勾几个删（batch-delete），
和「清理 NAS 上已经没了的样本」。两份各写一遍的话，以后新加一张挂 samples
外键的表，只会想起改其中一份，另一边就开始撞 1451。
"""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.clip import ClipJob
from app.models.inference_run import SampleInferenceRun
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.task import Task
from app.services.task_service import purge_task_children


async def delete_samples(db: AsyncSession, samples: list[Sample]) -> dict:
    """
    删掉这些样本，连同它们上面的任务和任务下面的东西。提交由调用方负责。

    返回 {"deleted": n, "tasks_deleted": m}。
    """
    if not samples:
        return {"deleted": 0, "tasks_deleted": 0}
    ids = [s.id for s in samples]

    task_ids = list((await db.execute(select(Task.id).where(Task.sample_id.in_(ids)))).scalars())
    if task_ids:
        # 标签条目→候选→标注记录→审核记录，按外键顺序清。跟删项目/删任务同一套，
        # 不要在这里另写一份，不然以后新加的表又会漏
        await purge_task_children(db, task_ids)
        await db.execute(delete(Task).where(Task.id.in_(task_ids)))
    # 这两张也挂着 samples 的外键，不清的话下面 delete 会撞 1451
    await db.execute(delete(ClipJob).where(ClipJob.sample_id.in_(ids)))
    await db.execute(delete(SampleInferenceRun).where(SampleInferenceRun.sample_id.in_(ids)))

    # media_files 是按路径唯一的，而**同一次录制的好几个样本共用同一组 cam 视频**
    # （狗场是 6 只狗共用天花板那路，影棚是几只狗共用三路）。所以不能见路径就删——
    # 删掉一个样本会把兄弟样本的视频登记一起带走，那几个任务打开就变成
    # "没有找到可播放的视频"，而 NAS 上文件明明还在。
    # 只删「删完之后没有任何样本还在用」的那些路径。
    paths = {
        p
        for s in samples
        for p in (s.video_cam1_path, s.video_cam2_path, s.video_cam3_path, s.imu_csv_path)
        if p
    }
    if paths:
        still_used: set[str] = set()
        for col in (
            Sample.video_cam1_path,
            Sample.video_cam2_path,
            Sample.video_cam3_path,
            Sample.imu_csv_path,
        ):
            still_used |= set(
                (await db.execute(select(col).where(col.in_(paths), Sample.id.notin_(ids)))).scalars()
            )
        orphan = paths - still_used
        if orphan:
            await db.execute(delete(MediaFile).where(MediaFile.relative_path.in_(orphan)))

    await db.execute(delete(Sample).where(Sample.id.in_(ids)))
    return {"deleted": len(ids), "tasks_deleted": len(task_ids)}
