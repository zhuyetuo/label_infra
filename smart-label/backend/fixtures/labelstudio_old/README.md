# 以前 Label Studio 标的那批数据（原始导出）

这里是 2026-06 ~ 08 在 Label Studio 上做的标注的**原始导出文件**，一个 zip 一个
数据集。`app/scripts/import_labelstudio_old.py` 直接读它们。

```
2026_7_17-2026_7_29.zip            15 个老项目   676 个任务    987 条标注
2026_8_11-2026_8_27_raw.zip        39 个老项目  1373 个任务   1464 条标注
2026_8_28_imu1_bb.zip               1 个老项目     8 个任务     84 条标注
2026_8_28_imu2_bali.zip             1 个老项目     7 个任务     28 条标注
2026_8_28_imu3_lulu.zip             1 个老项目    15 个任务     37 条标注
2026_8_28_imu4_xiaoman_unwear.zip   1 个老项目     9 个任务      9 条标注
                                    ────────────────────────────────────
                                   58 个老项目  2088 个任务   2609 条标注
```

## 为什么进版本库

一共 368KB，而这是**现在模型训练集的唯一来源**——Label Studio 那边已经不用了，
这几个 zip 没了就真没了，重标 2609 条不现实。

而且导入脚本是要反复跑的（先 dry-run 看统计、修了再跑、换台机器再跑），
每次都靠人手工找这几个文件、传进容器，迟早传错版本或者漏一个。跟脚本放在
同一个仓库里，`git pull` 下来就是配套的。

放 zip 不放解压后的 JSON：zip 一共 368KB，解压开是 2.5MB，而这些 JSON 从来
不需要 diff（它们是历史快照，只会整批替换，不会有人去改其中一行）。

## 容器里的路径

`backend/Dockerfile` 是 `COPY . .`、`WORKDIR /app`，所以这个目录在容器里是：

```
/app/fixtures/labelstudio_old
```

跑导入（服务名是 `api`，不是 `backend`）：

```bash
cd ~/label_infra/smart-label/deploy

# 先空跑看统计，什么都不写
docker compose exec api python -m app.scripts.import_labelstudio_old \
  --src /app/fixtures/labelstudio_old --dry-run

# 确认没问题再真导
docker compose exec api python -m app.scripts.import_labelstudio_old \
  --src /app/fixtures/labelstudio_old --user 1
```

`--src` 认 zip，会自己解压到临时目录，跑完就删。`--only 2026_8_28_imu1_bb`
可以只导最小那个数据集先试水。

## 以后再有新的导出

直接往这个目录里加 zip，目录名（zip 里的第一层）就是平台上的项目名去掉
`_old` 后缀。导入是幂等的，重跑只补没进去的，已经导过的一律不动。
